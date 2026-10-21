# 部署快速参考

## 最常用命令

```bash
# 一键发布和部署（自动递增版本号）
./scripts/release-and-deploy.sh

# 发布和部署指定版本
./scripts/release-and-deploy.sh 0.19.63

# 仅部署当前版本（不创建新版本）
./scripts/deploy.sh

# 部署指定已有版本
./scripts/deploy.sh v0.19.62
```

## 故障排查

```bash
# 查看生产日志
ssh root@37.221.196.102 'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml logs -f'

# 健康检查
curl https://studio.lingzhouai.com/api/health

# 重启服务
ssh root@37.221.196.102 'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml restart'

# 直接在服务器上部署
ssh root@37.221.196.102 '/opt/infinite-canvas-repo/quick-deploy.sh v0.19.62'
```

## 服务器结构

```
/opt/infinite-canvas/           # 部署目录（配置+数据）
/opt/infinite-canvas-repo/      # 源码仓库（用于构建）
```

## 部署原理

1. 服务器从 GitHub 拉取指定 tag
2. 在服务器上直接 `docker build`（不依赖 GitHub Actions）
3. 自动备份数据库
4. 更新 docker-compose.deploy.yml 中的镜像版本
5. 重启服务
6. 健康检查

**优势**: 快速、可控、不依赖 GitHub Actions
