#!/bin/bash
# 一键发布和部署脚本
# 用法: ./scripts/release-and-deploy.sh [版本号，如 0.19.63]

set -e

SERVER="37.221.196.102"
SSH_KEY="C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519"

# 获取版本号
if [ -z "$1" ]; then
    CURRENT_VERSION=$(cat VERSION)
    # 自动递增最后一位
    IFS='.' read -r major minor patch <<< "${CURRENT_VERSION#v}"
    NEW_VERSION="v${major}.${minor}.$((patch + 1))"
else
    NEW_VERSION="v$1"
fi

echo "=========================================="
echo "发布并部署 ${NEW_VERSION}"
echo "=========================================="
echo ""

# 1. 更新 VERSION 文件
echo "${NEW_VERSION}" > VERSION
echo "✅ 版本号已更新: ${NEW_VERSION}"

# 2. 更新 CHANGELOG
echo ""
echo "请手动更新 CHANGELOG.md（将 Unreleased 改为 ${NEW_VERSION}）"
read -p "完成后按回车继续..."

# 3. 提交代码
git add VERSION CHANGELOG.md
git commit -m "release: ${NEW_VERSION}" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
echo "✅ 代码已提交"

# 4. 打标签
git tag "${NEW_VERSION}"
echo "✅ 标签已创建: ${NEW_VERSION}"

# 5. 推送
git push origin main
git push origin "${NEW_VERSION}"
echo "✅ 代码和标签已推送"
echo ""

# 6. 在服务器上构建和部署
echo "第6步: 服务器端构建和部署..."
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "${SSH_KEY}" root@${SERVER} \
    "/opt/infinite-canvas-repo/quick-deploy.sh ${NEW_VERSION}"

echo ""
echo "=========================================="
echo "✅ 发布完成"
echo "=========================================="
echo "版本: ${NEW_VERSION}"
echo "健康检查: https://studio.lingzhouai.com/api/health"
