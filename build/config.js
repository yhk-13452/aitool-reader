// 部署路径的唯一来源。换 repo 名 / 换部署地址时只改 APP_SLUG 这一行。
// vite.config.js 用它配 base 与 manifest；浏览器端一律读 import.meta.env.BASE_URL，
// 不要 import 本文件（这是构建期配置，不该进业务代码）。
export const APP_SLUG = 'aitool-reader'

export const BASE_URL = `/${APP_SLUG}/`
