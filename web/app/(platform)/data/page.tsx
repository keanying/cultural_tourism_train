import { redirect } from "next/navigation";

/** 原「数据管理」已并入「数据资产 → 蒸馏数据」 */
export default function DataPage() {
  redirect("/assets/data");
}
