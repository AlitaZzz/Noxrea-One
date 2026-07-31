import { prisma } from "@server/core/database/client";
import { stringifyJson } from "./_json";

// ── Canvas CRUD（对应 backend/app/crud/canvas.py） ──

export async function getProjects(userId: number) {
  return prisma.canvasProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
}

export async function getProject(id: number) {
  return prisma.canvasProject.findUnique({ where: { id } });
}

export async function createProject(
  userId: number,
  data: { name?: string; canvasData?: Record<string, unknown> }
) {
  return prisma.canvasProject.create({
    data: {
      userId,
      name: data.name ?? "Untitled",
      canvasData: stringifyJson(data.canvasData ?? {}),
    },
  });
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

  return prisma.canvasProject.update({
    where: { id },
    data: updateData,
  });
}

export async function deleteProject(id: number) {
  return prisma.canvasProject.delete({ where: { id } });
}

// ── 文件引用重算（对应 Python file_references 的 upsert + deleteMany） ──

export async function recalcFileReferences(
  projectId: number,
  fileHashes: { hash: string; userId: number; refType: string }[]
) {
  const refType = "canvas_project";

  return prisma.$transaction(async (tx) => {
    // 删除旧引用
    await tx.fileReference.deleteMany({
      where: { refType, refId: projectId },
    });

    // 插入新引用
    if (fileHashes.length > 0) {
      const data = fileHashes.map((f) => ({
        fileHash: f.hash,
        userId: f.userId,
        refType,
        refId: projectId,
      }));

      await tx.fileReference.createMany({ data });
    }
  });
}
