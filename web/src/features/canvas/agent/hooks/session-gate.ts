/**
 * Agent 会话创建门闸：世代令牌 + 单飞。
 *
 * ensureSession 的竞态根因：await createSession 期间会话可能被 newChat / 切项目 /
 * 切会话重置，await 后只检查 current 是否被"别人设置"无法识别"已被重置为 null"，
 * 会把旧世代创建的孤儿会话挂到新对话上。世代令牌在每次会话身份变更（reset /
 * adopt）时递增，ensure 捕获发起时的世代，resolve 后世代不一致即视为孤儿会话，
 * 放弃挂载（服务端留下一个空会话，可被用户手动删除，不影响正确性）。
 *
 * 单飞：并发的 ensure 共用同一次创建，避免重复会话；单飞槽位绑定世代，
 * 世代已切换的旧在途创建不共享给新调用（其结果注定被放弃，复用会把新世代
 * 的创建吞成 null）。
 * 错误语义：创建失败时拒绝传播给所有共用者，由调用方（hook）统一提示。
 * createSession 由 ensure 调用时传入（携带当次的 projectId 等身份参数）；
 * 在途创建被放弃后槽位清空，下一次 ensure 用新参数重新创建。
 */

export interface AgentSessionRef {
  id: number;
  title: string | null;
}

export type SessionCreator = (
  initialTitle?: string
) => Promise<{ id: number; title?: string | null }>;

export interface SessionGate {
  readonly current: AgentSessionRef | null;
  reset(): void;
  adopt(session: AgentSessionRef): void;
  ensure(createSession: SessionCreator, initialTitle?: string): Promise<AgentSessionRef | null>;
}

export function createSessionGate(): SessionGate {
  let current: AgentSessionRef | null = null;
  let generation = 0;
  let pending: Promise<AgentSessionRef | null> | null = null;
  let pendingGeneration = 0;

  return {
    get current() {
      return current;
    },
    reset() {
      generation += 1;
      current = null;
    },
    adopt(session) {
      generation += 1;
      current = session;
    },
    ensure(createSession, initialTitle) {
      if (current) return Promise.resolve(current);
      if (pending && pendingGeneration === generation) return pending;

      const gen = generation;
      const attempt = async (): Promise<AgentSessionRef | null> => {
        const session = await createSession(initialTitle);
        // 等待期间会话身份已切换（newChat / 切项目 / 切会话）：孤儿会话放弃挂载
        if (generation !== gen) return null;
        current = { id: session.id, title: session.title ?? null };
        return current;
      };
      const p = attempt();
      pending = p;
      pendingGeneration = gen;
      const clear = () => {
        if (pending === p) pending = null;
      };
      void p.then(clear, clear);
      return p;
    },
  };
}
