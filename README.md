# Edge 控制工具

这套工具连接正在运行的常规 Edge，保留用户已有的登录状态和扩展。控制前请先阅读 [AI-GUIDE.md](AI-GUIDE.md) 和 [AGENTS.md](AGENTS.md)。

首次使用时，请在 Edge 地址栏打开 `edge://inspect`，进入 **Remote debugging（远程调试）**，勾选允许当前浏览器实例远程调试。

如果页面没有 **Remote debugging** 选项，可能是 Edge 版本较旧。请打开 `edge://settings/help` 查看版本并更新，更新后重新检查；浏览器策略或配置也可能影响该选项。

在本目录的 PowerShell 中检查：

```powershell
& .\edge_mcp.ps1 -Tool edge_status -Ensure
```

返回浏览器版本和标签页才表示连接成功。`http://127.0.0.1:9333/health` 只说明后台程序是否响应，不代表 Edge 已连接。

如果连接失败，请按 AI-GUIDE.md 排查，不要直接重置 Edge 或切换其他控制方式。用户要求：要换方式时必须先停下并询问。

Edge 本身的远程调试开关可在 `edge://inspect` 的“远程调试”页面查看；具体生效方式随 Edge 版本和配置变化。需要 Node.js 版本 22 或更高版本（提供原生 WebSocket）。启动脚本会检查版本；未安装或版本过低时会提示前往 [Node.js 官方下载页面](https://nodejs.org/zh-cn/download)，会尝试使用 Windows 程序包管理器自动安装 Node.js LTS；如果安装不可用或失败，可按提示手动安装。

## 功能与权限

工具可以查看和操作标签页、截图，以及查看、比对和更新油猴脚本。它还提供 Cookie 读取、本地文本文件读写和本机命令执行能力，使用当前用户的权限。只应让可信的 AI 客户端或程序调用。

常驻服务仅监听本机，**没有调用方身份认证**；其他本机程序仍可能调用它。不要将端口转发或暴露到网络。程序会拒绝带浏览器来源标头的请求，但这不能替代身份认证。

`auto-allow-debug.ps1` 是可选脚本，运行后会尝试自动点击 Edge 的远程调试授权；它不会由正常启动流程自动调用。不希望自动授权时不要运行它。密码和验证码由用户自行输入。

## 油猴脚本

`tm_scripts` 查看脚本；`tm_verify` 比对；`tm_push` 更新。比对和更新必须指定 `filePath` 和目标 `uuid`。更新会重载扩展，默认不刷新页面；主动指定刷新时需要 `tabFilter`，请先保存网页内容。油猴版本变化可能影响兼容性。

## 停止后台桥

手动运行 `start-bridge.cmd` 时，可关闭其命令窗口或按 Ctrl+C。通过 `-Ensure` 自动启动的后台桥，可先查看 `http://127.0.0.1:9333/health` 中的进程 ID 和目录，确认属于本工具且没有其他任务使用，再通过任务管理器结束对应 Node.js 进程；不要结束 Edge。

更多调用和排错说明见 [AI-GUIDE.md](AI-GUIDE.md)。

