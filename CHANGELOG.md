# Changelog

## Unreleased

- 明确提交日志、CHANGELOG、新功能说明和 Release 文案默认使用中文。
- 新增中文日志检查脚本、commit-msg hook 和 focuxdot 推送前提交标题校验。
- Release workflow 改为从 CHANGELOG 版本章节生成用户可读更新说明。

## v0.1.2

- 新增启动配置弹窗的“跳过本次”按钮，方便 CC-switch 等外部工具直接启动 Codex-ZH。
- 新增“以后不再显示这个配置弹窗”选项，用户可以永久关闭缺配置时的自动弹窗。
- 新增 `CodexZhLauncher.exe --skip-config` 参数，外部启动器可以跳过本次配置向导。
- 优化安装包文件名，统一使用 `Codex-版本+ZH-版本-win-x64.exe` 格式。
- 补充维护者推送身份校验，避免用错误 GitHub 账号发布。

## v0.1.1

- 记录 Codex-ZH 的开源边界和公开/私有凭据策略。
- 将私有 Windows 构建主机信息替换为公开安全的占位说明。
- 补充开源贡献、安全和 CI 基础配置。
