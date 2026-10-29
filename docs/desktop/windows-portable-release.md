# Windows 便携版服务器构建

## 规则与所有者

GitHub Actions 的 `windows-portable` 工作流是 Windows x64 免安装 ZIP 的构建和发布所有者。
向 `workbuddy-cn` 推送提交触发构建；不使用开发者电脑上的 `out`、缓存产物或账号数据。
Node 和 pnpm 版本分别从 `mise.toml`、`package.json` 读取，依赖使用锁文件安装。
复用桌面 runtime 准备、生产构建、electron-builder 配置和 afterPack 校验，不改变应用运行行为。

```text
提交 SHA → GitHub Windows runner → 锁文件安装 → 类型检查 / Lint
                                              ↓
GitHub 预发布 Release ← ZIP + SHA256 ← 解压启动验收 ← Agent + Desktop 构建 / 打包
```

## 产物与发布

- ZIP 解压后运行 `ZCode.exe`，无需安装；用户数据继续使用应用默认目录。
- 不包含构建者账号、会话或凭据，不需要 apiredirect 进程。
- 禁用自动更新及可选遥测配置；无签名证书时发布未签名开发版。
- Release 标签使用 `workbuddy-cn-<完整 SHA>`，绑定本次构建 SHA；同 SHA 重跑仅替换同名资产。
- 同一分支的构建串行发布，不取消已经开始发布的运行；失败不发布可下载版本。
- ZIP 和 SHA256 同时保存到 Actions artifact，再发布到 GitHub prerelease。

## 验收

1. 干净 Windows runner 仅凭仓库与公开依赖完成构建，内嵌 Agent 必须重新构建。
2. 类型检查、Lint 和打包配置的 runtime/native 校验通过。
3. ZIP 解压到临时目录，用独立空 profile 启动；登录页、WorkBuddy 国内入口、空账号面板正常。新 profile 出现职业引导时，使用产品支持的 Escape 退出后继续，不写入伪造的引导记录。
4. 内嵌 Agent 完成 workspace 初始化，不使用真实账号或付费推理。
5. 解压目录无 `.zcode-runtime`、`.run-logs`、账号配置、会话数据库；构建元数据 SHA 对应当前提交。
6. SHA256 对应上传 ZIP；启动检查失败时保留截图、页面文本、启动日志和未验收 ZIP 作为诊断 artifact，不创建可下载 Release。

当前不覆盖真实账号推理、完整桌面 E2E 或所有单测；已有扩大测试失败不宣称通过。
