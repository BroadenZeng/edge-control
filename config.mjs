// 可移植配置：不写死任何用户路径，按操作系统和安装位置自动推断。
// 任何一项都可以用环境变量覆盖：
//   EDGE_PATH            Edge 浏览器可执行文件
//   EDGE_PROFILE         浏览器 user data 目录
//   EDGE_ACTIVE_PORT_FILE  已开调试端口的实例写出的 DevToolsActivePort 路径
//   CDP_PORT / MCP_HTTP_PORT
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const KIT_DIR = dirname(fileURLToPath(import.meta.url));

const LOCAL = env.LOCALAPPDATA || join(env.USERPROFILE || env.HOME || '.', 'AppData', 'Local');
const PF86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const PF = env.ProgramFiles || 'C:\\Program Files';

const edgeCandidates = [
  env.EDGE_PATH,
  join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

const browser = edgeCandidates.find((p) => existsSync(p)) || edgeCandidates[0];

const userDataDir = env.EDGE_PROFILE || join(LOCAL, 'Microsoft', 'Edge', 'User Data');
const defaultPortFile = join(userDataDir, 'DevToolsActivePort');

// 只有在文件真的存在时才启用“读端口文件”这条路径，否则退回 HTTP 发现
const activePortFile = env.EDGE_ACTIVE_PORT_FILE
  ? env.EDGE_ACTIVE_PORT_FILE
  : existsSync(defaultPortFile)
    ? defaultPortFile
    : '';


export const CFG = {
  kitDir: KIT_DIR,
  browser,
  browserFound: existsSync(browser),
  userDataDir,
  activePortFile,
  cdpPort: Number(env.CDP_PORT || 9222),
  httpPort: Number(env.MCP_HTTP_PORT || 9333),
};

