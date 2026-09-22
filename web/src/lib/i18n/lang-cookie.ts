// 语言 cookie 名的唯一定义处。
// 独立成模块（不带任何 i18n 依赖）：服务端根布局只需读这个常量，
// 不能从 config.ts 导入——那会把 react-i18next 拉进 server bundle。
export const LANG_COOKIE = "noxrea-lang";
