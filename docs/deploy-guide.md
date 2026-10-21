# 部署指南

## 简化的发布和部署流程

### 方式1: 一键发布和部署（推荐）

适用于：创建新版本并立即部署到生产环境

```bash
# 在本地仓库根目录执行
./scripts/release-and-deploy.sh

# 或指定版本号
./scripts/release-and-deploy.sh 0.19.63
```

这个脚本会：
1. 更新 VERSION 文件
2. 提示更新 CHANGELOG.md
3. 提交代码并打 tag
4. 推送到 GitHub
5. 在服务器上构建镜像并部署
6. 自动进行健康检查

### 方式2: 仅部署已有版本

适用于：重新部署某个已发布的版本，不创建新版本

```bash
# 部署当前 VERSION 文件中的版本
./scripts/deploy.sh

# 部署指定版本
./scripts/deploy.sh v0.19.62
```

### 方式3: 直接在服务器上操作

如果本地脚本出问题，可以直接 SSH 到服务器执行：

```bash
# SSH 到服务器
ssh -i C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519 root@37.221.196.102

# 在服务器上执行
/opt/infinite-canvas-repo/quick-deploy.sh v0.19.62

# 或部署最新 tag
/opt/infinite-canvas-repo/quick-deploy.sh
```

## 部署原理

### 服务器端结构

```
/opt/infinite-canvas/              # 部署目录（只含配置和数据）
├── docker-compose.deploy.yml      # Compose 配置
├── data/                          # 数据库和上传文件
└── deploy_infinite_canvas_image.sh # 旧的部署脚本（已废弃）

/opt/infinite-canvas-repo/         # 完整源码仓库
├── Dockerfile                     # 镜像构建文件
├── quick-deploy.sh                # 快速部署脚本
└── ...                            # 完整项目代码
```

### 部署流程

1. **获取代码**：从 GitHub 拉取指定 tag
2. **构建镜像**：在服务器上直接 `docker build`
3. **备份数据**：自动备份数据库并校验
4. **更新配置**：修改 docker-compose.deploy.yml 中的镜像版本
5. **重启服务**：`docker compose up -d`
6. **健康检查**：轮询 https://studio.lingzhouai.com/api/health

### 优势

- **不依赖 GitHub Actions**：fork 仓库、Actions 被禁用都不影响
- **速度快**：服务器直接构建，不需要推送镜像
- **可控性强**：出问题可以直接在服务器上调试
- **自动备份**：每次部署前自动备份数据库

## 故障排查

### 部署失败

```bash
# 查看服务日志
ssh root@37.221.196.102 'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml logs --tail=100'

# 查看当前运行状态
ssh root@37.221.196.102 'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml ps'

# 重启服务
ssh root@37.221.196.102 'docker compose -f /opt/infinite-canvas/docker-compose.deploy.yml restart'
```

### 构建失败

```bash
# SSH 到服务器
ssh -i C:/Users/Administrator/.ssh/racknerd-ef66d95_ed25519 root@37.221.196.102

# 手动执行构建步骤
cd /opt/infinite-canvas-repo
git fetch origin
git checkout v0.19.62
docker build -t ghcr.io/thinkinwalk/infinite-canvas:v0.19.62 .
```

### 回滚到旧版本

```bash
# 部署任意旧版本
./scripts/deploy.sh v0.19.61
```

## 日常工作流

### 开发 → 发布 → 部署

```bash
# 1. 本地开发和测试
npm run dev

# 2. 提交代码
git add .
git commit -m "feat: 新功能"

# 3. 一键发布和部署
./scripts/release-and-deploy.sh
```

就这么简单！

### 仅代码提交（不发版本）

```bash
git add .
git commit -m "fix: 修复bug"
git push
```

### 发版本但不立即部署

```bash
# 手动更新 VERSION 和 CHANGELOG
echo "v0.19.63" > VERSION
vim CHANGELOG.md

# 提交
git add VERSION CHANGELOG.md
git commit -m "release: v0.19.63"
git tag v0.19.63
git push origin main
git push origin v0.19.63

# 需要时再部署
./scripts/deploy.sh v0.19.63
```

## 健康检查

部署完成后，访问：
- https://studio.lingzhouai.com/api/health

或通过命令行：
```bash
curl -s https://studio.lingzhouai.com/api/health | python -m json.tool
```
