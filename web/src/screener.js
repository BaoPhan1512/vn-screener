// Kiểm tra một mã có thoả tất cả điều kiện lọc hay không.
// Một điều kiện: { left: {f, p}, op, right: {f, p} | {v}, right2?: {v}, off?: true }

export function testFilter(ctx, flt) {
  const a = ctx.value(flt.left, 0);
  const b = ctx.value(flt.right, 0);
  if (a == null || b == null) return false;
  switch (flt.op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "between": {
      const c = ctx.value(flt.right2 || { v: Infinity }, 0);
      return a >= Math.min(b, c) && a <= Math.max(b, c);
    }
    case "crossUp":
    case "crossDown": {
      const a1 = ctx.value(flt.left, 1);
      const b1 = ctx.value(flt.right, 1);
      if (a1 == null || b1 == null) return false;
      return flt.op === "crossUp" ? a1 <= b1 && a > b : a1 >= b1 && a < b;
    }
  }
  return false;
}

export function passes(ctx, filters) {
  for (const f of filters) if (!f.off && !testFilter(ctx, f)) return false;
  return true;
}
