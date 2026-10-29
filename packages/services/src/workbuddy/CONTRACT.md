# WorkBuddy 国内

适配器通过私有原子文件与共享锁唯一管理账号凭据、待授权、积分和签到状态。
Provider/Model 写入经过原有 ProviderSettingsFacade，RPC 普通操作只返回脱敏视图，显式 export-login 例外返回用于用户复制的登录信息。
登录与手动刷新读取个人账号昵称和 ID，缓存于加密状态；资料失败保留旧资料并提示，不增加状态轮询网络访问。
每渠道独立密钥保护本机回环推理；各 Host 共用端口，退出后由其它 Host 接管。
回环同时兼容 Chat Completions 与完整历史的 Responses；协议层转换请求与流，不持有账号或任务状态。首次内容前校验上游模型，缺失完成原因或截断不能报告成功；积分归属仍由 Runtime 唯一写入。
创建渠道默认使用 Responses；启动时通过 ProviderSettingsFacade 幂等迁移带 WorkBuddy 标识的旧个人 Chat 配置，保留账号、模型与用户设置。分片中的空工具列表不拆分 reasoning item，上游核心函数保持原样。
自动签到北京时间每天至多尝试一次，领取超时查状态，不盲目重发。
桌面 Host 拥有运行期，设置页没有后台状态所有权，ZCode 退出后无常驻进程。
账号目录保存上游模型说明、活动标签、上下文选项、reasoning 能力和批量忙闲快照；status 不访问上游，sync-models 刷新目录及忙闲，并 通过现有 Facade 更新 reasoning 规格，保留其余个人配置。未声明多个档位的模型不提供可调档位；请求按上游合法档位/默认值传递 reasoning_effort，核心不改。
验收见 docs/model-provider/workbuddy-cn.md。
活动通过 /v3/config 白名单解析后并入账号目录，UI 派生时段/倍率，status 不联网。每账号拥有默认关闭的 allowModelFallback，双方开启时仅6004在输出前尝试其它已登录启用的同ID模型，实际账号记用量，不修改会话模型。显式登录导出例外返回短期 loginExport，普通状态不含令牌；导入先远端验证再替换generation与账号缓存，保持渠道密钥/开关。
