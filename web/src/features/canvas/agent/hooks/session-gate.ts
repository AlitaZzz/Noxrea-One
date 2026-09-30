/**
 * Agent 会话身份门闸：世代令牌 + 单飞 + 在途读取围栏。
 *
 * ensureSession 的竞态根因：await createSession 期间会话可能被 newChat / 切项目 /
 * 切会话重置，await 后只检查 current 是否被"别人设置"无法识别"已被重置为 null"，
 * 会把旧世代创建的孤儿会话挂到新对话上。世代令牌在每次会话身份变更（reset /
 * adopt / ensure 挂载成功）时递增，ensure 捕获发起时的世代，resolve 后世代不一致
 * 即视为孤儿会话，放弃挂载（服务端留下一个空会话，可被用户手动删除，不影响正确性）。
 *
 * 在途读取围栏（loadHistory / loadSessions）：异步读取 await 返回后必须校验世代
 * 仍然一致，才允许写 UI / 门闸 / chatId——身份已变后，旧异步结果不再拥有修改当前
 * 会话状态的资格。两类读取语义不同：
 *   - loadHistory 会切换会话身份，属「身份意图」：经 beginLoad 登记并递增世代，
 *     后点的会话使先点的在途响应失效（后发生的意图胜出）；它也会孤儿化在途的
 *     会话创建（切会话即放弃发送）。
 *   - loadSessions 是纯读取，只快照比对、不递增——避免首条消息创建在途时打开
 *     历史面板把 ensure 孤儿化、静默丢消息。
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
  /** 当前世代令牌：会话身份变更（reset / adopt / ensure 挂载成功）与读取登记（beginLoad）时递增 */
  readonly generation: number;
  reset(): void;
  adopt(session: AgentSessionRef): void;
  /**
   * 登记一次会切换会话身份的在途读取（loadHistory）：递增世代并返回登记值。
   * await 返回后经 isCurrent 校验，不一致即陈旧响应，必须整体丢弃。
   */
  beginLoad(): number;
  /** 世代是否仍是当前世代（在途异步结果返回后的有效性校验） */
  isCurrent(generation: number): boolean;
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
    get generation() {
      return generation;
    },
    reset() {
      generation += 1;
      current = null;
    },
    adopt(session) {
      generation += 1;
      current = session;
    },
    beginLoad() {
      generation += 1;
      return generation;
    },
    isCurrent(gen) {
      return generation === gen;
    },
    ensure(createSession, initialTitle) {
      if (current) return Promise.resolve(current);
      if (pending && pendingGeneration === generation) return pending;

      const gen = generation;
      const attempt = async (): Promise<AgentSessionRef | null> => {
        const session = await createSession(initialTitle);
        // 等待期间会话身份已切换（newChat / 切项目 / 切会话 / 在途读取登记）：孤儿会话放弃挂载
        if (generation !== gen) return null;
        // 挂载成功同样是身份转移（无会话 → 新会话）：递增世代，使发起早于本次
        // 创建的在途读取在返回后按陈旧响应丢弃——后发生的意图胜出
        current = { id: session.id, title: session.title ?? null };
        generation += 1;
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
