#!/bin/bash
# 快速部署脚本（不创建版本，只部署）
# 用法: ./scripts/deploy.sh [版本号，默认为当前 VERSION]

set -e

SERVER="37.221.196.102"
SSH_KEY="C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519"

# 获取版本号
if [ -z "$1" ]; then
    VERSION=$(cat VERSION)
else
    VERSION="v$1"
fi

echo "=========================================="
echo "部署 ${VERSION} 到生产环境"
echo "=========================================="
echo ""

ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "${SSH_KEY}" root@${SERVER} \
    "/opt/infinite-canvas-repo/quick-deploy.sh ${VERSION}"

echo ""
echo "=========================================="
echo "✅ 部署完成"
echo "=========================================="
echo "版本: ${VERSION}"
echo "健康检查: https://studio.lingzhouai.com/api/health"
