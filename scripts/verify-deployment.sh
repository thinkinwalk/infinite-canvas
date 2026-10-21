#!/bin/bash
# 验证部署结果

SERVER="37.221.196.102"
SSH_KEY="C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519"

echo "验证部署结果..."
echo ""

# 1. 检查容器状态
echo "1. 容器状态:"
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "${SSH_KEY}" root@${SERVER} \
    'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml ps'
echo ""

# 2. 检查镜像版本
echo "2. 当前镜像:"
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "${SSH_KEY}" root@${SERVER} \
    'grep "image:" /opt/infinite-canvas/docker-compose.deploy.yml'
echo ""

# 3. 健康检查
echo "3. 健康检查:"
if curl -sf https://studio.lingzhouai.com/api/health > /dev/null; then
    echo "✅ 服务正常"
    curl -s https://studio.lingzhouai.com/api/health | python -m json.tool
else
    echo "❌ 服务异常"
fi
echo ""

# 4. 查看最近日志
echo "4. 最近日志（最后10行）:"
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "${SSH_KEY}" root@${SERVER} \
    'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml logs --tail=10'
