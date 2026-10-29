export function escape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
export function page(content: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>脑海 · 本机设置</title><style>
:root{font-family:system-ui,sans-serif;color:#18332e;background:#f4f7f6}body{margin:0}main{max-width:940px;margin:48px auto;padding:0 24px}h1{font-size:32px;margin-bottom:8px}p{line-height:1.8;color:#516660}section{background:white;border:1px solid #dde6e2;border-radius:12px;padding:24px;margin:24px 0}label{display:block;margin:16px 0 6px;font-size:14px}input:not([type=checkbox]),select{box-sizing:border-box;width:100%;padding:11px;border:1px solid #bdcec5;border-radius:6px;font:inherit}button{padding:11px 20px;background:#145b48;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer;margin-top:20px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px 8px;border-bottom:1px solid #e4ece7}code{overflow-wrap:anywhere}a{color:#145b48}.muted{color:#65766e;font-size:14px}details{margin-top:16px}summary{cursor:pointer}header{border-bottom:1px solid #dce6e1;padding-bottom:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:650px){.grid{grid-template-columns:1fr}main{margin-top:24px}td,th{padding:8px 3px}}
</style><main><header><h1>脑海</h1><p>本机个人设置 · 按人员与工作区启用</p></header>${content}</main></html>`;
}
