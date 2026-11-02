"""独立验证：把 GitHub 远端仓库的内容拉回来，与本地逐字节比对。

不信任发布脚本自己的输出 —— 脚本说成功了不算，这里重新从 API 拉一遍，
用「本地 git 算出的 blob SHA」对照「远端 tree 里的 blob SHA」。

SHA 是内容寻址的：blob SHA 相同 ⟺ 文件字节完全相同（除非 SHA 碰撞，忽略）。
所以这一步验证的是**字节级一致**，不是「看着差不多」。

用法：
    python scripts/verify-remote.py --repo my-repo
    python scripts/verify-remote.py --repo my-repo --owner someone --branch main
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_publish_module():
    """按路径加载 publish-via-api.py。

    文件名带连字符（不是合法 Python 模块名），所以不能用普通的 import 语句，
    只能用 importlib 按文件路径加载。
    """
    path = HERE / "publish-via-api.py"
    spec = importlib.util.spec_from_file_location("publish_via_api", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"加载不了 {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PV = _load_publish_module()


def main() -> int:
    ap = argparse.ArgumentParser(description="把远端仓库拉回来与本地逐字节比对")
    ap.add_argument("--repo", required=True, help="仓库名（不含 owner）")
    ap.add_argument("--owner", default=None,
                    help="仓库 owner（默认取 token 所属账号）")
    ap.add_argument("--branch", default="master", help="分支（默认 master）")
    ap.add_argument("--tag", default=None, help="额外抽查的 tag（默认取最新版本 tag）")
    args = ap.parse_args()

    gh = PV.Gh(PV.read_token(args.owner))
    user = gh.get("/user")
    owner = args.owner or user["login"]
    repo = f"{owner}/{args.repo}"

    info = gh.get(f"/repos/{repo}")
    print(f"仓库      : {info['full_name']}")
    print(f"可见性    : private={info['private']}  visibility={info.get('visibility')}")
    print(f"默认分支  : {info.get('default_branch')}")
    print(f"许可证    : {info.get('license', {}).get('spdx_id') if info.get('license') else '（未识别）'}")
    print(f"描述      : {info.get('description')}")

    print("\n=== 1) 分支与 HEAD ===")
    br = gh.get(f"/repos/{repo}/branches")
    local_branches = PV.git("branch", "-l", "--format=%(refname:short)").split()
    for b in br:
        remote_sha = b["commit"]["sha"]
        local_sha = (PV.git("rev-parse", b["name"]).strip()
                     if b["name"] in local_branches else None)
        mark = "✓ 与本地一致" if local_sha == remote_sha else \
            ("" if local_sha is None else "✗ 与本地不一致")
        print(f"  {b['name']:<10} {remote_sha[:12]}  {mark}")

    print("\n=== 2) 文件字节级比对（blob SHA 逐个对照）===")
    local_head = PV.git("rev-parse", args.branch).strip()
    head_tree = gh.get(f"/repos/{repo}/git/trees/{local_head}?recursive=1")
    remote = {e["path"]: e["sha"] for e in head_tree.get("tree", []) if e["type"] == "blob"}
    local = {e["path"]: e["sha"] for e in PV.tree_entries(args.branch) if e["type"] == "blob"}

    only_local = sorted(set(local) - set(remote))
    only_remote = sorted(set(remote) - set(local))
    diff = sorted(p for p in set(local) & set(remote) if local[p] != remote[p])

    print(f"  本地文件 {len(local)}  远端文件 {len(remote)}")
    print(f"  字节一致 {len(set(local) & set(remote)) - len(diff)} / {len(local)}")
    if only_local:
        print(f"  ✗ 只在本地: {only_local[:5]}")
    if only_remote:
        print(f"  ✗ 只在远端: {only_remote[:5]}")
    if diff:
        print(f"  ✗ 内容不同: {diff[:5]}")
    if not (only_local or only_remote or diff):
        print("  ✓ 全部文件字节级一致（blob SHA 逐一相同）")

    print("\n=== 3) 提交历史 ===")
    commits = gh.get(f"/repos/{repo}/commits?per_page=100")
    print(f"  远端提交数（首页）: {len(commits)}")
    local_commits = PV.git("rev-list", "--count", args.branch).strip()
    print(f"  本地提交数        : {local_commits}")
    for c in commits[:3]:
        print(f"    {c['sha'][:12]}  {c['commit']['message'].splitlines()[0][:52]}")

    print("\n=== 4) tag ===")
    tags = gh.get(f"/repos/{repo}/tags?per_page=100")
    print(f"  远端 tag 数: {len(tags)}")
    local_tags = PV.git("tag", "-l").split()
    print(f"  本地 tag 数: {len(local_tags)}")
    remote_names = {t["name"] for t in tags}
    missing = sorted(set(local_tags) - remote_names)
    print(f"  ✓ 全部 {len(local_tags)} 个 tag 都在远端" if not missing
          else f"  ✗ 缺: {missing[:5]}")

    check_tag = args.tag
    if not check_tag:
        # 默认抽查最新版本 tag（本地按版本号排序取最大）
        vers = sorted([t for t in local_tags if t.startswith("v")],
                      key=lambda s: [int(x) for x in s[1:].split(".")])
        check_tag = vers[-1] if vers else (local_tags[0] if local_tags else None)
    if check_tag:
        local_tag_sha = PV.git("rev-parse", check_tag).strip()
        hit = [t for t in tags if t["name"] == check_tag]
        if hit:
            rc = hit[0]["commit"]["sha"]
            lc = PV.git("rev-parse", f"{check_tag}^{{}}").strip()
            print(f"  {check_tag} 指向 commit: 远端 {rc[:12]} / 本地 {lc[:12]} "
                  f"{'✓' if rc == lc else '✗'}")
            print(f"  {check_tag} tag 对象 SHA: 本地 {local_tag_sha[:12]}（附注 tag，"
                  f"远端 API 不直接暴露对象 SHA，但指向的 commit 已验证）")

    print("\n=== 5) 关键文件抽查（从远端拉回字节再比）===")
    for path in ["README.md", "LICENSE", "package.json", "CHANGELOG.md",
                 "web/dist/demo.html", "web/dist/index.html", "track-pi/src/agent.ts"]:
        try:
            r = gh.raw("GET", f"https://api.github.com/repos/{repo}/contents/{path}")
            if isinstance(r[1], dict) and r[1].get("content"):
                remote_bytes = base64.b64decode(r[1]["content"])
                local_bytes = PV.git("cat-file", "blob", f"{args.branch}:{path}", binary=True)
                same = remote_bytes == local_bytes
                print(f"  {path:<28} {len(local_bytes):>8} B  "
                      f"{'✓ 字节完全一致' if same else '✗ 有差异'}")
            else:
                print(f"  {path:<28} 远端返回异常")
        except Exception as e:
            print(f"  {path:<28} 拉取失败: {str(e)[:60]}")

    print("\n=== 6) 敏感内容复查（远端实际文件里有没有不该有的东西）===")
    head = gh.get(f"/repos/{repo}/git/trees/{local_head}?recursive=1")
    paths = [e["path"] for e in head.get("tree", []) if e["type"] == "blob"]
    suspicious = [p for p in paths
                  if any(k in p.lower() for k in
                         ("secret", "credential", ".env", "token", "password",
                          "audit.jsonl", "state.json", ".deepseek-key"))]
    print(f"  可疑路径: {suspicious if suspicious else '无'}")
    print(f"  data/ 与 reports/ 是否入库: "
          f"{'是（有问题）' if any(p.startswith(('data/', 'reports/')) for p in paths) else '否 ✓'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
