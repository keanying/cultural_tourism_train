"use client";

import { use } from "react";
import { ChunkWorkspace } from "@/components/ChunkWorkspace";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ChunkWorkspace chunkId={Number(id)} mode="label" />;
}
