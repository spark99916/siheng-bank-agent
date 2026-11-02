#!/usr/bin/env bash
# 把本地仓库推到 GitHub 公开仓库 siheng-bank-agent。
#
# 前提：能连 github.com（公司网络/手机热点可能通，本机直连实测被拦）。
# 用法：
#   bash scripts/publish-github.sh              # 交互式：会让你输入 GitHub 用户名与 Token
#   bash scripts/publish-github.sh 用户名 Token  # 直接带参数（不推荐，会留在 shell 历史里）
#
# Token 权限：public_repo（建公开仓库 + 推代码）即可，不需要更多。
# 取 Token：GitHub 右上头像 → Settings → Developer settings → Personal access tokens
#           → Tokens (classic) → Generate new token → 勾 public_repo → Generate。
#
# 脚本做四件事，且每步都验：
#   1. 检查仓库该推的分支与 tag 都在本地
#   2. 在 GitHub 上建公开仓库（已存在就跳过，不动已有内容）
#   3. 配 remote 并 push 分支与全部 tag
#   4. 拉回来核对 SHA 与本地一致

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/spark99916/siheng-bank-agent.git}"
API="https://api.github.com"

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."

# ---------- 0. 环境检查 ----------
say "0/5 检查环境"
command -v git >/dev/null || die "找不到 git"
command -v curl >/dev/null || die "找不到 curl"
git config user.name  >/dev/null || die "git user.name 没配"
git config user.email >/dev/null || die "git user.email 没配"

# 网络探活（被拦就早停，别等到 push 才失败）
curl -sS -o /dev/null --max-time 20 "$API" \
  || die "连不上 api.github.com —— 换个网络（手机热点试过再放弃）"

# ---------- 1. 拿凭据 ----------
say "1/5 获取 GitHub 凭据"
if [ "$#" -ge 2 ]; then
  GH_USER="$1"; GH_TOKEN="$2"
else
  printf 'GitHub 用户名（如 spark99916）：'; read -r GH_USER
  printf 'Personal access token（输入不回显）：'; read -rs GH_TOKEN; printf '\n'
fi
[ -n "$GH_USER" ] || die "用户名不能为空"
[ -n "$GH_TOKEN" ] || die "token 不能为空"

AUTH=(-u "$GH_USER:$GH_TOKEN" -H "Accept: application/vnd.github+json")

# ---------- 2. 本地状态检查 ----------
say "2/5 检查本地仓库状态"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "有未提交的改动 —— 先 commit 再推（tag 推的是已提交的内容）"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TAG="$(git describe --tags --abbrev=0)"
HEAD_SHA="$(git rev-parse HEAD)"
printf '分支 %s\ntag   %s\nHEAD  %s\n' "$BRANCH" "$TAG" "$HEAD_SHA"

# 推送前的安全闸：确认没有密钥类文件被跟踪
say "   扫描跟踪文件里的密钥"
if git ls-files -z | xargs -0 grep -lIE "sk-[a-zA-Z0-9]{20,}" 2>/dev/null | grep -q .; then
  die "跟踪文件里疑似有 API Key，先清理再推"
fi
echo "   未发现硬编码密钥"

# ---------- 3. 建仓（不存在才建） ----------
say "3/5 准备 GitHub 仓库"
REPO_NAME="${REPO_URL##*/}"; REPO_NAME="${REPO_NAME%.git}"
CODE=$(curl -sS -o /tmp/_gh_repo.json -w '%{http_code}' "${AUTH[@]}" "$API/repos/$GH_USER/$REPO_NAME")
if [ "$CODE" = "200" ]; then
  echo "仓库已存在，跳过创建：$REPO_URL"
elif [ "$CODE" = "404" ]; then
  echo "创建公开仓库 $GH_USER/$REPO_NAME ..."
  CODE=$(curl -sS -o /tmp/_gh_new.json -w '%{http_code}' "${AUTH[@]}" \
    -X POST "$API/user/repos" \
    -d "{\"name\":\"$REPO_NAME\",\"description\":\"2026 FinTechathon 人工智能赛道作品「司衡」—— 面向零售银行的 AI Agent 内核，可解释的三色判定内核\",\"private\":false,\"auto_init\":false}")
  [ "$CODE" = "201" ] || { cat /tmp/_gh_new.json; die "建仓失败（HTTP $CODE）"; }
  echo "已创建：$REPO_URL"
else
  cat /tmp/_gh_repo.json; die "查仓失败（HTTP $CODE）—— 多半是 token 权限不足或用户名不对"
fi

# ---------- 4. 推送 ----------
say "4/5 推送代码"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi
echo "remote origin -> $REPO_URL"

git push -u origin "$BRANCH" || die "推分支失败"
git push --tags            || die "推 tag 失败"

# ---------- 5. 核对 ----------
say "5/5 核对远端 SHA"
REMOTE_SHA=$(curl -sS "${AUTH[@]}" "$API/repos/$GH_USER/$REPO_NAME/commits/$BRANCH" \
  | grep -m1 '"sha"' | cut -d'"' -f4)
printf '本地 %s\n远端 %s\n' "$HEAD_SHA" "$REMOTE_SHA"
[ "$HEAD_SHA" = "$REMOTE_SHA" ] || die "SHA 对不上，远端不是刚才推的那一版"

say "完成"
cat <<EOF
仓库地址（填进报名表）：
  https://github.com/$GH_USER/$REPO_NAME

README 里的链接已按这个地址写好，不用再改。

下一步：
  1. 打开仓库首页，确认 README 正常显示
  2. 在仓库 Settings → Pages 里把 Source 设为 main 分支根目录，
     会有一个公开网址（可选，演示站本来就是双击即开的单文件，不依赖它）
  3. 把上面的仓库地址填进报名表的 GitHub 一栏
EOF
