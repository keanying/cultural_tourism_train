import "server-only";
import { jsonError } from "./db";

type Ctx = { params: Promise<Record<string, string>> };

/** 路由包装：统一异常处理 */
export function handle(fn: (req: Request, params: Record<string, string>) => Promise<Response> | Response) {
  return async (req: Request, ctx: Ctx) => {
    try {
      return await fn(req, ctx?.params ? await ctx.params : {});
    } catch (e) {
      return jsonError(e);
    }
  };
}

export async function body(req: Request): Promise<Record<string, any>> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
