# Edge Control

让 AI 助手操作正在使用的 Microsoft Edge，使用现有的登录状态和扩展。

## 环境要求

- Windows、Windows PowerShell 5.1 或 PowerShell 7。
- 包含 **Remote debugging（远程调试）** 选项的 Edge；找不到时请先更新浏览器。
- 能运行本机命令的 AI 助手，以及 Node.js 22 或更高版本。缺少合适版本时，工具会尝试通过 `winget` 安装 Node.js LTS，也可从 [Node.js 官网](https://nodejs.org/zh-cn/download)安装。

## 开始使用

### 1. 开启远程调试

在 Edge 打开 `edge://inspect`，进入 **Remote debugging（远程调试）**，开启当前浏览器实例的远程调试。

### 2. 选择使用方式

**方式一：安装本地技能**

安装一次，之后使用无需重复安装。将下面的话发给 AI 助手：

> 请根据 GitHub 上 BroadenZeng 的 [edge-control 仓库](https://github.com/BroadenZeng/edge-control)创建并安装本地技能，用于控制当前 Edge。

**方式二：直接使用项目文件夹**

无需安装技能，支持本地命令的 AI 助手可直接使用。[下载 ZIP](https://github.com/BroadenZeng/edge-control/archive/refs/heads/main.zip) 并解压，将实际文件夹路径告诉 AI 助手，例如：

> 请使用 `D:\你的路径\edge-control` 控制当前 Edge。

### 3. 验证连接

在项目文件夹中打开 PowerShell，或让 AI 运行：

```powershell
& .\edge_mcp.ps1 -Tool edge_status -Ensure
```

首次连接如出现 Edge 远程调试授权提示，请手动点击允许。返回 Edge 版本和标签页列表表示连接成功；后续重连会尝试自动处理授权提示。

## 功能

- 读取页面、识别元素、点击、填写、等待、滚动、按键和截图。
- 选择本地文件上传、观察下载目录、查看控制台消息和处理网页弹窗。
- 查看、比对和更新油猴脚本。
- 按需读写本地文件、执行命令和读取浏览器 Cookie。

## 已知限制

下载观察只能列出目录中的新增文件，不能确认来源或下载是否完成。页面快照可能不包含 iframe 和部分自定义组件；提交和上传后应检查结果。

## 权限

> **仅供可信的 AI 助手和程序使用。** 常驻服务默认监听本机 `127.0.0.1:9333`，**没有调用方身份认证**。能访问该服务的本机程序可以当前 Windows 用户权限执行命令、读写文件，并在浏览器连接后读取 Cookie（包括 HttpOnly）。请勿将端口暴露到网络。

重连时的自动授权会短暂监听 Edge 调试提示，可能同时匹配其他程序发起的提示。

## 常见问题

- **找不到远程调试选项**：在 `edge://settings/help` 检查并更新 Edge；浏览器策略也可能影响该选项。
- **连接失败**：确认 Edge 正在运行、远程调试已开启，并检查授权提示。将具体错误交给 AI 排查。
- **反复出现授权提示**：首次连接需手动处理；后续重连会短暂尝试自动处理。AI 客户端自身的权限提示不由该脚本处理。如需恢复首次手动授权，让 AI 调用 `edge_auto_reset`。
- **油猴功能不可用**：确认已安装扩展和目标脚本；扩展版本变化可能影响兼容性。

## 资料

- [AGENTS.md](AGENTS.md)：AI 操作约定。
- [AI-GUIDE.md](AI-GUIDE.md)：工具用法与排错。
- [MIT 许可证](LICENSE)：允许使用、修改和分发，须保留版权声明和许可证文本。

