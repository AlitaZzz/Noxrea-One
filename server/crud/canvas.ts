/**
 * 画布工程 CRUD。
 * 按用户读写画布工程、节点数据与缩略图等持久化信息。
 */
import { prisma } from "@server/core/database/client";
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

export async function getProject(id: number) {
  const project = await prisma.canvasProject.findUnique({ where: { id } });
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
  id: number,
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

  const updated = await prisma.canvasProject.update({
    where: { id },
    data: updateData,
  });
  return {
    ...updated,
    canvasData: parseJsonObject(updated.canvasData),
  };
}

export async function deleteProject(id: number) {
  return prisma.canvasProject.delete({ where: { id } });
}

