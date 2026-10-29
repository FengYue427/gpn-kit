// JS mod 入口:官方文档的所有示例都使用 export default { setup(ctx) {} } 的形式。
// 本文件仅演示官方 "Hello" 示例中出现的 API(ctx.ui.toast),
// 完整 API 见 https://pvzge.com/en/guide/mod/gp-next-api-reference.html
export default {
  setup(ctx) {
    ctx.ui.toast('Hello from gpn-kit!', 'success')
  }
}
