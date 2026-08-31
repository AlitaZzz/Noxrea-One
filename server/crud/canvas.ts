/**
 * 画布工程 CRUD。
 * 按用户读写画布工程、节点数据与缩略图等持久化信息。
 */
import { prisma } from "@server/core/database/client";
import { newId } from "@server/utils/id";
import { stringifyJson, parseJsonObject } from "./_json";

export async function getProjects(userId: number) {
  const projects = await prisma.canvasProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return projects.map((p) => ({
    ...p,
    canvasData: parseJsonObject(p.canvasData),
  }));
}

export async function getProject(id: string, userId: number) {
  const project = await prisma.canvasProject.findFirst({ where: { id, userId } });
  if (!project) return null;
  return {
    ...project,
    canvasData: parseJsonObject(project.canvasData),
  };
}

export async function createProject(
  userId: number,
  data: { name?: string; canvasData?: Record<string, unknown> }
) {
  const project = await prisma.canvasProject.create({
    data: {
      id: newId(),
      userId,
      name: data.name ?? "Untitled",
      canvasData: stringifyJson(data.canvasData ?? {}),
    },
  });
  return {
    ...project,
    canvasData: parseJsonObject(project.canvasData),
  };
}

export async function updateProject(
  id: string,
  userId: number,
  data: { name?: string; canvasData?: Record<string, unknown> }
) {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) {
    updateData.name = data.name;
  }
  if (data.canvasData !== undefined) {
    updateData.canvasData = stringifyJson(data.canvasData);
  }

  // updateMany 同时承担存在性与归属校验：where 带上 userId，避免原来
  // "findFirst 校验 + update({ where: { id } })" 两步之间丢失归属约束的
  // 权限窗口（与 deleteProject 的写法保持一致）
  const result = await prisma.canvasProject.updateMany({
    where: { id, userId },
    data: updateData,
  });
  if (result.count === 0) return null;

  const updated = await prisma.canvasProject.findUnique({ where: { id } });
  if (!updated) return null;
  return {
    ...updated,
    canvasData: parseJsonObject(updated.canvasData),
  };
}

export async function deleteProject(id: string, userId: number) {
  return prisma.canvasProject.deleteMany({ where: { id, userId } });
}

