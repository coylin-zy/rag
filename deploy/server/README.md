# 香港服务器前端部署模板

该目录保存 `/srv/apps/rag` 中与前端可靠性有关的非敏感配置。部署包还需要：

- 将 `pnpm build:web` 生成的 `dist/` 内容复制到 `web/`。
- 在服务器创建 `secrets/rag-proxy-auth.conf`，不要将其提交到 Git。
- 生成覆盖部署包的 `MANIFEST.sha256`。

部署必须执行：

```bash
sudo bash scripts/deploy.sh
```

部署脚本会等待容器通过覆盖全部入口 JS/CSS 的健康检查，然后执行 `scripts/validate.sh`，验证容器、HTTPS 源站、API 会话、Nginx 配置和证书。任一检查失败都会以非零状态结束。
