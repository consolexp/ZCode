# WorkBuddy 上游快照

来自用户指定的 `F:/svn/apiredirect`（2026-10-28）。运行时不访问该仓库。

| 本地文件     | 参考文件                     | 原始 SHA-256                                                     |
| ------------ | ---------------------------- | ---------------------------------------------------------------- |
| wb-proxy.mjs | vendor/wb-proxy/wb-proxy.mjs | c2c71113261cee9b362497d45f5988e73e7c1ddd671eb953681ceada7d870652 |
| protocol.mjs | src/providers/protocol.js    | 7e5794f4bcc69542c7b209e08e5f6dd0621447cf0a414d526f20ec5a3fa25e90 |

`protocol.mjs` 只把两处 require 和末尾 module.exports 转为 ESM 导入导出，函数体逐字保留。桌面 Host 使用 ESM 打包，内联 CommonJS 的内置模块 require 会导致启动崩溃；`vendor.test.ts` 实际运行 CJS/ESM 两种打包结果。`worker.js` 作为适配流程参考，其 Capture、输入准入和调用顺序位于外层 `transport.ts`；不引入其进程调度、账号文件或 Qoder 代码。

`wb-proxy.mjs` 只有以下嵌入修改，核心函数体保持原样：

1. 导入之后加 `createWorkbuddy(embedding)` 实例工厂，ENDPOINT 从注入参数取得。
2. `resilientRequest` 开头增加网络注入，`withAuthRetry` 开头增加鉴权注入；原实现保留。ZCode 的文件锁、账号代次与一次 401 刷新仍由 Runtime 负责；429 交由原有 Agent 重试，本适配层不另加重试。
3. main 段包进未自动执行的 `main()`，工厂末尾返回 `handleChat`、`responsesToChat`、`chatToResponseObject` 和 `mapUsage`。

更新时替换快照、重施以上三处嵌入修改并更新哈希；运行 `packages/services/test/workbuddy` 的定向测试。`vendor.test.ts` 将移除嵌入修改后校验原始哈希，避免核心代码在本地渐渐分叉。

`.d.mts` 是 ZCode 的类型边界；协议转换、输出校验和 SSE 聚合保留在上游。积分观察、错误脱敏、取消信号和账户持久化留在外层。MIT 许可见 LICENSE 和上级 THIRD_PARTY_NOTICES.md。
