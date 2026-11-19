---
name: edge-control
description: 控制用户正在使用的 Microsoft Edge，读取和操作指定网页或管理油猴脚本。
---

# Edge Control

使用已安装的 Edge Control 连接用户正在使用的 Edge，保留现有登录状态和扩展。

## 安装

安装技能时，将本仓库保存在稳定的本地目录，把 `SKILL.md` 安装到目标客户端的技能目录，并将仓库绝对路径写入同一技能目录下的 `edge-control-path.txt`。不要将仓库路径写成其他用户电脑上的固定路径。

## 定位项目

优先使用用户指定的项目目录或环境变量 `EDGE_CONTROL_HOME`。从本技能目录下的 `edge-control-path.txt` 读取安装时记录的项目绝对路径；若技能仍在仓库的 `skills/edge-control` 中，也可使用其上两级目录。确认目录包含 `edge_mcp.ps1`、`AGENTS.md` 和 `AI-GUIDE.md`。找不到项目时，告知用户并确定项目位置，不要猜测或改用其他浏览器。

## 操作

先读取项目的 `AGENTS.md` 和 `AI-GUIDE.md`。在项目目录执行：

```powershell
& .\edge_mcp.ps1 -Tool edge_status -Ensure
```

以返回的 Edge 版本和标签页判断连接；`health` 正常不代表 Edge 已连接。优先用 `tab_snapshot` 和 `tab_action` 操作用户指定的页面，并验证结果。匹配不到或匹配多个页面、元素时停止，避免误操作。

保留用户的登录状态和未保存内容。密码、验证码及其他凭据由用户控制，不输出 Cookie、调试连接凭据或敏感数据。首次调试授权由用户处理；后续自动授权遵循项目配置。

本方法不可用时说明错误；未经用户明确同意，不切换浏览器、控制工具、桥或配置，也不强制关闭 Edge、重置数据或修改安全策略。涉及写入、上传、提交或油猴脚本更新时，按用户授权操作并检查结果。

