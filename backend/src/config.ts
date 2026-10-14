/**
 * 配置（环境变量）：
 *   PORT       端口，默认 8765（插件设置里的默认端口）
 *   HOST       监听地址，默认 0.0.0.0（局域网都能访问）
 *   DATA_DIR   数据目录（数据库），默认 ./data
 *   STATIC_DIR 网页文件，默认 ../frontend/dist
 *   ADMIN_PASSWORD 第一次启动时设置管理密码（之后在网页“设置”里改）
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.PORT || 8765);
export const HOST = process.env.HOST || "0.0.0.0";
export const DATA_DIR = resolve(process.env.DATA_DIR || "data");
export const STATIC_DIR = resolve(process.env.STATIC_DIR || resolve(here, "../../frontend/dist"));
export const VERSION = "1.0.0";
