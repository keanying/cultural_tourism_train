import { requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/db";
import { getModel, ping } from "@/lib/gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 连通性测试：发一条最短对话，返回回复、实际协议与耗时 */
export const POST = handle(async (req, { id }) => {
  requireArea(req, "data");
  const m = getModel(Number(id));
  if (!m.api_key_value) throw new HttpError(400, "请先填写 API Key");
  try {
    return Response.json(await ping(m));
  } catch (e: any) {
    throw new HttpError(502, String(e?.message ?? e));
  }
});
