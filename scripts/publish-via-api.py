"""用 GitHub REST API 把本地 git 仓库逐字节复刻到远端（等价于 git push，但走 api.github.com）。

为什么不用 git push：某些网络环境里 git 协议到 github.com 不通（直连超时、代理 502），
但 api.github.com 通。GitHub 的 Git Data API 能完整表达一次 push：
    blob → tree → commit → ref
而且 git 是内容寻址的 —— 同样的 tree/parent/author/committer/message 灌进去，
GitHub 算出来的 commit SHA 与本地**完全一致**。所以这不是「近似上传」，是字节级复刻。

用法：
    # 推全部历史（首次发布，或远端是空仓）
    python scripts/publish-via-api.py --repo my-repo

    # 远端已有历史，只推本地新增的提交（增量）
    python scripts/publish-via-api.py --repo my-repo --incremental

    # 只建仓并试第一个提交，比对 SHA
    python scripts/publish-via-api.py --repo my-repo --dry

凭据来源（按顺序）：
    1. 环境变量 GITHUB_TOKEN / GH_TOKEN（通用，CI 与各平台都认）
    2. Windows 凭据管理器里 `GitHub - https://api.github.com/<用户名>` 那条
       （Windows + Git Credential Manager 登录过就有）
**任何情况下都不把 token 写进命令行参数** —— 那会留在 shell 历史里。
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.wintypes as wintypes
import datetime
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"

# 脚本放在 <repo>/scripts/ 下时，仓库根就是上一级；
# 用 --repo-dir 或环境变量 SIHENG_REPO_DIR 可覆盖。
REPO_DIR = Path(os.environ.get("SIHENG_REPO_DIR")
                or os.environ.get("REPO_DIR")
                or Path(__file__).resolve().parent.parent)

CRED_TYPE_GENERIC = 1
CRED_PREFIX = "GitHub - https://api.github.com/"


def cred_target(owner: str) -> str:
    """Windows 凭据管理器里那条 GitHub 条目的名字。"""
    return f"GitHub - https://api.github.com/{owner}"


class CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


_advapi32 = ctypes.WinDLL("advapi32.dll", use_last_error=True)
_advapi32.CredReadW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
                                ctypes.POINTER(ctypes.POINTER(CREDENTIALW))]
_advapi32.CredReadW.restype = wintypes.BOOL
_advapi32.CredFree.argtypes = [ctypes.c_void_p]


def _credential_owner_hints() -> list:
    """猜可能的凭据条目用户名。

    拿 token 要知道用户名（凭据条目名里带用户名），而从 token 反查用户名又需要 token ——
    鸡生蛋。所以这里从本地 git 配置与 remote URL 里捞几个可能值，
    真正的兜底是调用方用 `--owner` 或 `GH_USER` 显式指定。
    """
    hints = []
    for key in ("github.user", "gh.user", "user.name"):
        r = subprocess.run(["git", "config", "--get", key], cwd=str(REPO_DIR),
                           capture_output=True)
        if r.returncode != 0:
            continue
        out = r.stdout.decode("utf-8", "replace").strip()
        if out and out not in hints:
            hints.append(out)
    # remote URL 里直接就有 owner：git@github.com:<owner>/<repo>.git
    r = subprocess.run(["git", "remote", "-v"], cwd=str(REPO_DIR), capture_output=True)
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        m = re.search(r"[:/]([^/:]+)/[^/]+\.git", line)
        if m and m.group(1) not in hints:
            hints.append(m.group(1))
    return hints


def read_token(owner: str | None = None) -> str:
    """取 GitHub token。

    优先环境变量 `GITHUB_TOKEN`（通用，CI 与各平台都认）；
    其次读 Windows 凭据管理器里的 GitHub 条目。

    owner 传了就优先试 `GitHub - https://api.github.com/<owner>`；
    没传（或没命中）就按常见条目名探测 ——
    `gh` CLI 建的条目是 `GitHub - https://api.github.com/<用户名>`，
    Git Credential Manager 建的是 `git:https://github.com`；
    用户名还可以从本地 git 配置里猜几个。

    **不枚举整个凭据库**（CredEnumerateW 在部分 Windows 环境下会直接崩），
    改成按名字探测 —— 慢一点，但不会把进程带崩。

    **任何情况下都不把 token 写进命令行参数** —— 那会留在 shell 历史里。
    """
    env = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env:
        return env.strip()

    if not sys.platform.startswith("win"):
        raise SystemExit(
            "请设置环境变量 GITHUB_TOKEN（权限 public_repo 即可）：\n"
            "  export GITHUB_TOKEN=ghp_xxx")

    candidates = []
    for who in [owner] + _credential_owner_hints():
        if who:
            candidates.append(cred_target(who))
    candidates += [
        "git:https://github.com",
        "git:https://github.com/",
        "github.com",
    ]
    for target in candidates:
        tok = _read_credential(target)
        if tok:
            print(f"  用到凭据管理器条目: {target}")
            return tok
    raise SystemExit(
        "凭据管理器里读不到 GitHub 条目（试过: " + ", ".join(candidates) + "）\n"
        "改用环境变量：export GITHUB_TOKEN=ghp_xxx")


def _read_credential(target: str) -> str | None:
    """读一条通用凭据的明文；读不到返回 None。"""
    p = ctypes.POINTER(CREDENTIALW)()
    if not _advapi32.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(p)):
        return None
    try:
        c = p.contents
        raw = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize)
        if b"\x00" in raw:
            txt = raw.decode("utf-16-le", errors="replace")
        else:
            txt = raw.decode("utf-8", errors="replace")
        return txt.strip().rstrip("\x00")
    finally:
        _advapi32.CredFree(p)


class Gh:
    """极简 GitHub API 客户端（只用标准库，顺手记一下限流余量）。"""

    def __init__(self, token: str, min_interval: float = 0.35):
        self.token = token
        self.calls = 0
        self.remaining = -1
        self.min_interval = min_interval      # 两次写请求的最小间隔（秒）
        self._next_at = 0.0
        self._throttle_lock = threading.Lock()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "siheng-publish",
        }

    def raw(self, method: str, url: str, body=None, expect=(200, 201, 204)):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        # 节流：GitHub 对「短时间大量内容创建」会触发二级限流（403 temporarily blocked）
        with self._throttle_lock:
            now = time.monotonic()
            wait = self._next_at - now
            if wait > 0:
                time.sleep(wait)
            self._next_at = time.monotonic() + self.min_interval
        for attempt in range(6):
            # 每次请求都新建 Request 与 opener：并发下复用连接会偶发 404
            req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
            if data:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    self.calls += 1
                    rem = r.headers.get("X-RateLimit-Remaining")
                    if rem:
                        self.remaining = int(rem)
                    raw = r.read()
                    return r.status, (json.loads(raw) if raw else {})
            except urllib.error.HTTPError as e:
                payload = e.read().decode("utf-8", "replace")
                if e.code == 404 and attempt < 3:
                    # 并发下 GitHub 偶发 404（连接复用导致），退避重试
                    time.sleep(0.6 * (attempt + 1))
                    continue
                if e.code == 422 and attempt == 0:
                    continue
                if e.code in (403, 429) and attempt < 5:
                    if "secondary rate limit" in payload:
                        print("    [二级限流] 等 60s 再试…", flush=True)
                        time.sleep(60)
                    else:
                        time.sleep(2 + attempt * 3)
                    continue
                raise RuntimeError(f"{method} {url} → HTTP {e.code}: {payload[:300]}") from e
            except urllib.error.URLError as e:
                if attempt < 5:
                    time.sleep(1 + attempt)
                    continue
                raise RuntimeError(f"{method} {url} → {e}") from e
        raise RuntimeError(f"{method} {url} → 重试耗尽")

    def get(self, path):
        return self.raw("GET", API + path)[1]

    def post(self, path, body):
        return self.raw("POST", API + path, body)[1]

    def patch(self, path, body):
        return self.raw("PATCH", API + path, body)[1]


def git(*args: str, binary: bool = False):
    r = subprocess.run(["git", *args], cwd=str(REPO_DIR), capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} 失败: {r.stderr.decode('utf-8', 'replace')[:300]}")
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def git_ok(*args: str) -> bool:
    """跑一个 git 命令，只关心成功与否。

    `merge-base --is-ancestor` 在「不是祖先」时退出码是 1 —— 那是正常结论，
    不是错误，所以不能用会抛异常的 git()。
    """
    r = subprocess.run(["git", *args], cwd=str(REPO_DIR), capture_output=True)
    return r.returncode == 0


def ensure_repo(gh: Gh, name: str, description: str, owner: str, user_login: str) -> dict:
    """建公开仓；已存在就复用（不覆盖已有内容）。

    先 GET 探活、只在真不存在时才 POST —— 因为 POST /user/repos 属于「内容创建」，
    仓库已存在时也照样计入 GitHub 的二级限流配额，会把后续上传全拖住。
    """
    try:
        existing = gh.get(f"/repos/{owner}/{name}")
        print(f"  仓库已存在，复用: {existing['full_name']}  "
              f"(private={existing['private']}, visibility={existing.get('visibility')})")
        return existing
    except RuntimeError:
        pass  # 404 → 还没建

    # 个人仓走 /user/repos，组织仓走 /orgs/<org>/repos
    if owner == user_login:
        endpoint, payload = "/user/repos", {}
    else:
        endpoint, payload = f"/orgs/{owner}/repos", {"type": "public"}
    try:
        r = gh.post(endpoint, {
            "name": name, "description": description, "private": False,
            "auto_init": False, "has_issues": True, "has_wiki": False, **payload,
        })
    except RuntimeError as e:
        if "already exists" in str(e) or "Repository creation failed" in str(e):
            existing = gh.get(f"/repos/{owner}/{name}")
            print(f"  仓库已存在，复用: {existing['full_name']}")
            return existing
        raise
    if isinstance(r, list):
        # GitHub 对「同名仓库已存在」返回 201 + 仓库列表（不是 422）
        existing = r[0] if r else gh.get(f"/repos/{owner}/{name}")
        print(f"  仓库已存在，复用: {existing['full_name']}")
        return existing
    print(f"  建仓成功: {r['full_name']}  (private={r['private']})")
    return r


def bootstrap(gh: Gh, repo: str, branch: str) -> str:
    """空仓库禁用 Git Data API（409 Git Repository is empty）。

    解禁办法：用 Contents API 上传一个占位文件，产生首个提交。
    随后复刻历史时会把分支 ref 强制指向真正的第一个提交，这个占位提交就成了悬空对象
    （GitHub 会自动 GC，不影响可见历史）。
    """
    path = ".bootstrap-placeholder"
    # 幂等第一步：文件已存在就说明仓库已非空、Git Data API 已解禁，
    # 直接返回，**不再发 PUT** —— 每次 PUT 都算一次「内容创建」，会吃二级限流配额。
    try:
        existing = gh.get(f"/repos/{repo}/contents/{path}")
        if isinstance(existing, dict) and existing.get("sha"):
            print("  占位提交已存在（仓库已非空，Git Data API 可用）")
            return existing["sha"]
    except RuntimeError:
        pass

    body = {
        "message": "chore: bootstrap placeholder (superseded by full history replay)",
        "content": base64.b64encode(b"placeholder\n").decode("ascii"),
        "branch": branch,
    }
    try:
        r = gh.raw("PUT", f"{API}/repos/{repo}/contents/{path}", body)
    except RuntimeError as e:
        if "Branch" in str(e) and "not found" in str(e):
            # 目标分支不存在 → 先在默认分支建，再由后续步骤改 ref
            body.pop("branch", None)
            r = gh.raw("PUT", f"{API}/repos/{repo}/contents/{path}", body)
        else:
            raise
    sha = r[1]["commit"]["sha"]
    print(f"  占位提交已建（用于解禁 Git Data API）: {sha[:12]}")
    return sha


def create_blob(gh: Gh, repo: str, sha: str, cache: dict) -> str:
    """上传一个 blob；GitHub 按内容算 SHA，返回值应与本地一致。"""
    if sha in cache:
        return cache[sha]
    content = git("cat-file", "blob", sha, binary=True)
    r = gh.post(f"/repos/{repo}/git/blobs", {
        "content": base64.b64encode(content).decode("ascii"),
        "encoding": "base64",
    })
    if r["sha"] != sha:
        raise SystemExit(f"blob SHA 不一致: 本地 {sha} / 远端 {r['sha']}")
    cache[sha] = sha
    return sha


def meta_tree_of(commit: str) -> str:
    """取某提交的 tree SHA。"""
    return commit_meta(commit)["tree"]


def tree_entries(commit: str) -> list:
    """列出某提交整棵树的条目（递归），返回 [{path, mode, type, sha}]。"""
    out = git("ls-tree", "-r", "-z", commit)
    entries = []
    for rec in out.split("\0"):
        if not rec:
            continue
        meta, path = rec.split("\t", 1)
        mode, typ, sha = meta.split()
        entries.append({"path": path, "mode": mode, "type": typ, "sha": sha})
    return entries


def changed_paths(parent: str, commit: str) -> list:
    """两个提交之间变化的文件路径（含新增、删除、修改）。

    注意必须加 --no-renames：重命名要拆成「删除旧名 + 新增新名」，
    否则 tree 里会同时留着旧路径。
    """
    if not parent:
        return [e["path"] for e in tree_entries(commit)]
    out = git("diff-tree", "-r", "--no-commit-id", "--name-only", "-z",
              "--no-renames", parent, commit)
    return [p for p in out.split("\0") if p]


def deleted_paths(parent: str, commit: str) -> list:
    """这一版里被删掉的文件路径（增量建树时要显式传 sha:null 才会真删）。"""
    if not parent:
        return []
    out = git("diff-tree", "-r", "--no-commit-id", "--diff-filter=D",
              "--name-only", "-z", "--no-renames", parent, commit)
    return [p for p in out.split("\0") if p]


def commit_meta(commit: str) -> dict:
    """从 git cat-file 拿到精确的 author/committer/date/message。"""
    raw = git("cat-file", "commit", commit)
    head, _, message = raw.partition("\n\n")
    author = committer = None
    tree = parents = None
    for line in head.split("\n"):
        if line.startswith("tree "):
            tree = line[5:].strip()
        elif line.startswith("parent "):
            parents = (parents or []) + [line[7:].strip()]
        elif line.startswith("author "):
            author = line[7:]
        elif line.startswith("committer "):
            committer = line[10:]
    return {"tree": tree, "parents": parents or [], "author": author,
            "committer": committer, "message": message}


def split_ident(ident: str) -> dict:
    """'Name <mail> 1699999999 +0800' → {'name':..,'email':..,'date':iso}"""
    m = re.match(r"^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})$", ident)
    if not m:
        raise SystemExit(f"无法解析 ident: {ident!r}")
    name, mail, ts, tz = m.groups()
    dt = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc)
    sign = 1 if tz[0] == "+" else -1
    offset = datetime.timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])) * sign
    local = dt.astimezone(datetime.timezone(offset))
    # GitHub 要求带冒号的时区（+08:00），strftime 的 %z 给的是 +0800
    stamp = local.strftime("%Y-%m-%dT%H:%M:%S%z")
    stamp = stamp[:-2] + ":" + stamp[-2:]
    return {"name": name, "email": mail, "date": stamp}


def replay_commit(gh: Gh, repo: str, commit: str, parent: str, created: dict) -> str:
    """复刻一个提交（tree + commit），返回远端 commit SHA。

    两个关键点（都是实测踩出来的）：
    ① **必须按父子顺序**：commit 的 SHA 包含 parent SHA，
       给一个提交传空 parents 必然算出不一样的 SHA。
    ② **tree 用 base_tree 增量**：把父提交的 tree 作为基线，
       只提交这一版改动的文件。tree SHA 只由内容决定，
       所以只要改动对，远端 tree SHA 与本地必然相同。
    """
    meta = commit_meta(commit)

    # 本次改动的文件
    if parent:
        changed = set(changed_paths(parent, commit))
    else:
        changed = None      # root：整棵树
    entries = tree_entries(commit)
    if changed is not None:
        entries = [e for e in entries if e["path"] in changed]

    payload, binary = [], []
    for e in entries:
        if e["type"] != "blob":
            payload.append({"path": e["path"], "mode": e["mode"],
                            "type": e["type"], "sha": e["sha"]})
            continue
        content = git("cat-file", "blob", e["sha"], binary=True)
        try:
            # tree API 支持内联 content：文本文件不用先 POST /git/blobs
            payload.append({"path": e["path"], "mode": e["mode"],
                            "type": "blob", "content": content.decode("utf-8")})
        except UnicodeDecodeError:
            binary.append((e, content))
    for e, content in binary:
        rb = gh.post(f"/repos/{repo}/git/blobs", {
            "content": base64.b64encode(content).decode("ascii"),
            "encoding": "base64"})
        if rb["sha"] != e["sha"]:
            raise SystemExit(f"blob SHA 不一致: 本地 {e['sha']} / 远端 {rb['sha']}")
        payload.append({"path": e["path"], "mode": e["mode"],
                        "type": "blob", "sha": e["sha"]})

    # 被删除的文件：显式传 sha:null，否则 base_tree 里会留着旧文件
    for dp in deleted_paths(parent, commit) if parent else []:
        payload.append({"path": dp, "mode": "100644", "type": "blob", "sha": None})

    body = {"tree": payload}
    if parent:
        body["base_tree"] = meta_tree_of(parent)
    r = gh.post(f"/repos/{repo}/git/trees", body)
    if r["sha"] != meta["tree"]:
        raise SystemExit(f"tree 对不上: 本地 {meta['tree']} / 远端 {r['sha']}\n"
                         f"  提交 {commit[:10]}，父 {parent[:10] if parent else '(root)'}")

    cr = gh.post(f"/repos/{repo}/git/commits", {
        "message": meta["message"], "tree": r["sha"],
        "parents": [created.get(p, p) for p in meta["parents"]],
        "author": split_ident(meta["author"]),
        "committer": split_ident(meta["committer"]),
    })
    if cr["sha"] != commit:
        raise SystemExit(f"commit SHA 对不上: 本地 {commit} / 远端 {cr['sha']}")
    created[commit] = cr["sha"]
    return cr["sha"]


def remote_branch_head(gh: Gh, repo: str, branch: str):
    """取远端分支的 HEAD SHA；分支不存在返回 None。"""
    try:
        return gh.get(f"/repos/{repo}/git/ref/heads/{branch}")["object"]["sha"]
    except RuntimeError:
        return None


def local_branch_head(branch: str) -> str:
    return git("rev-parse", branch).strip()


def main() -> int:
    ap = argparse.ArgumentParser(
        description="用 GitHub REST API 把本地仓库逐字节复刻到远端")
    ap.add_argument("--repo", required=True, help="仓库名（不含 owner）")
    ap.add_argument("--owner", default=os.environ.get("GH_USER")
                    or os.environ.get("GITHUB_USER"), help="仓库 owner（默认取 token 所属账号）")
    ap.add_argument("--branch", default="master", help="目标分支（默认 master）")
    ap.add_argument("--description", default="", help="新建仓库时的描述")
    ap.add_argument("--incremental", action="store_true",
                    help="只推远端没有的提交（远端已有历史时用）")
    ap.add_argument("--dry", action="store_true", help="只建仓并试第一个提交")
    args = ap.parse_args()

    token = read_token(args.owner)
    gh = Gh(token)
    user = gh.get("/user")
    owner = args.owner or user["login"]
    print(f"身份: {owner}")
    repo = f"{owner}/{args.repo}"

    print("\n[1] 建仓")
    ensure_repo(gh, args.repo, args.description or f"{owner}/{args.repo}",
                owner, user["login"])

    if args.dry:
        print("\n[2] 试复刻第一个提交，比对 SHA")
        commits = git("rev-list", "--reverse", "--topo-order", args.branch).split()
        first = commits[0]
        meta = commit_meta(first)
        print(f"  本地首个提交 {first[:12]}  tree={meta['tree'][:12]}")
        print(f"  author  : {meta['author']}")
        print(f"  message : {meta['message'][:60]!r}")

        blobs = {e["sha"] for e in tree_entries(first) if e["type"] == "blob"}
        cache = {}
        for s in blobs:
            create_blob(gh, repo, s, cache)
        print(f"  已上传 {len(cache)} 个 blob")

        entries = tree_entries(first)
        r = gh.post(f"/repos/{repo}/git/trees", {"tree": [
            {"path": e["path"], "mode": e["mode"], "type": e["type"], "sha": e["sha"]}
            for e in entries]})
        print(f"  远端 tree = {r['sha'][:12]}  本地 tree = {meta['tree'][:12]}  "
              f"{'✓ 一致' if r['sha'] == meta['tree'] else '✗ 不一致'}")

        cr = gh.post(f"/repos/{repo}/git/commits", {
            "message": meta["message"],
            "tree": r["sha"],
            "parents": [],
            "author": split_ident(meta["author"]),
            "committer": split_ident(meta["committer"]),
        })
        print(f"  远端 commit = {cr['sha'][:12]}  本地 = {first[:12]}  "
              f"{'✓ 一致' if cr['sha'] == first else '✗ 不一致'}")
        print(f"\nAPI 调用 {gh.calls} 次，限流余量 {gh.remaining}")
        return 0

    # ---- 决定要复刻哪些提交 ----
    local_head = local_branch_head(args.branch)
    remote_head = remote_branch_head(gh, repo, args.branch)
    created: dict = {}

    if remote_head:
        # 远端已有历史 → 增量：只推远端没有的那一段
        if not git_ok("merge-base", "--is-ancestor", remote_head, local_head):
            print(f"\n✗ 远端 {args.branch} ({remote_head[:12]}) 不是本地 {args.branch} 的祖先，"
                  "不能增量 —— 历史分叉了。请人工确认后用全量模式重建。")
            return 1
        todo = git("rev-list", "--reverse", "--topo-order",
                   f"{remote_head}..{local_head}").split()
        print(f"\n[2] 增量模式：远端已有 {remote_head[:12]}，"
              f"本地多出 {len(todo)} 个提交")
        if not todo:
            print("  没有新提交，跳过提交复刻")
        # 第一个待推提交的父就是远端 HEAD，它的 tree 远端已经有了
        parent = remote_head
    else:
        print("\n[2] 解禁 Git Data API（空仓库禁用 tree/commit 端点）")
        try:
            bootstrap(gh, repo, args.branch)
        except RuntimeError as e:
            if "already exists" in str(e):
                print("  占位文件已存在，跳过")
            else:
                raise
        todo = git("rev-list", "--reverse", "--topo-order", args.branch).split()
        print(f"  全量模式：按父子顺序复刻 {len(todo)} 个提交")
        parent = None

    print("\n[3] 复刻提交")
    if remote_head:
        # 远端 HEAD 已经在远端存在，登记一下，
        # 好让第一个待推提交的 parents 正确指向它而不是退化成猜值
        created[remote_head] = remote_head
    for i, c in enumerate(todo, 1):
        meta = commit_meta(c)
        p = meta["parents"][0] if meta["parents"] else None
        replay_commit(gh, repo, c, p, created)
        if i % 10 == 0 or i == len(todo):
            print(f"  {i}/{len(todo)}  提交 {c[:10]} ✓  (API 调用 {gh.calls})")

    # ---- 建 ref ----
    print("\n[4] 建分支与 tag")
    head_sha = created.get(local_head, local_head)
    try:
        gh.post(f"/repos/{repo}/git/refs", {"ref": f"refs/heads/{args.branch}", "sha": head_sha})
        print(f"  分支 {args.branch} ✓")
    except RuntimeError as e:
        if "already exists" in str(e):
            gh.patch(f"/repos/{repo}/git/refs/heads/{args.branch}",
                     {"sha": head_sha, "force": True})
            print(f"  分支 {args.branch} 已存在，已强制指向真正 HEAD ✓")
        else:
            raise

    # tag：只补远端缺的（历史 tag 指向的 commit 若不在远端，硬建会 422）
    tags = git("tag", "-l").split()
    remote_tags = {t["name"] for t in gh.get(f"/repos/{repo}/tags?per_page=100")}
    ok_tags = 0
    for t in tags:
        if t in remote_tags:
            continue
        obj = git("rev-parse", f"{t}^{{}}").strip()
        typ = git("cat-file", "-t", t).strip()
        if typ == "tag":   # 附注 tag：先建 tag 对象
            raw = git("cat-file", "tag", t)
            head_txt, _, message = raw.partition("\n\n")
            tagger = next((l[7:] for l in head_txt.split("\n") if l.startswith("tagger ")), None)
            target = next((l[7:].strip() for l in head_txt.split("\n") if l.startswith("object ")), "")
            tobj = gh.post(f"/repos/{repo}/git/tags", {
                "tag": t, "message": message,
                "object": created.get(target, target),
                "type": "commit",
                "tagger": split_ident(tagger) if tagger else None,
            })
            tag_sha = tobj["sha"]
        else:
            tag_sha = created.get(obj, obj)
        try:
            gh.post(f"/repos/{repo}/git/refs", {"ref": f"refs/tags/{t}", "sha": tag_sha})
        except RuntimeError as e:
            if "already exists" in str(e):
                gh.patch(f"/repos/{repo}/git/refs/tags/{t}", {"sha": tag_sha})
            else:
                raise
        ok_tags += 1
    print(f"  新建 tag {ok_tags} 个（远端已有 {len(remote_tags)} 个）✓")

    print(f"\nAPI 调用合计 {gh.calls} 次，限流余量 {gh.remaining}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
