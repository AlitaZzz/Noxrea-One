/**
 * 资产库查询 Hook。
 * 资产弹窗与画布抽屉共用同一条查询链路，避免两处各自维护搜索、筛选、分页和竞态规则。
 * 根目录规则：无搜索且无分类筛选时只展示文件夹；有搜索或筛选时跨全部资产查询。
 * 切换条件时不主动清空 listState：新首页到达前，渲染层直接沿用上一份列表作为占位，
 * 因此条件切换的第一帧（effect 尚未执行）也不会闪空态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchAssetPage } from "@/features/assets/store";
import type { AssetItem, AssetScope, AssetType } from "@/features/assets/types";

/** 资产库查询条件；categories 为空数组表示“全部类型”。 */
export interface AssetLibraryQuery {
  scope: AssetScope;
  folderId: string | null;
  search: string;
  categories: AssetType[];
}

/** Hook 返回的列表状态与操作；调用方可在外部批量更新或刷新列表。 */
export interface AssetLibraryState {
  items: AssetItem[];
  totalCount: number;
  loading: boolean;
  loadingMore: boolean;
  loadError: boolean;
  hasMore: boolean;
  reload: () => void;
  loadMore: () => void;
  /** 加载失败重试：已有首页结果时重拉下一页，否则重拉首页。 */
  retry: () => void;
  /** 删除成功后的本地同步：剔除列表项与计数，随后立即补页填满当前窗口。 */
  removeItems: (ids: string[]) => Promise<void>;
  setItems: React.Dispatch<React.SetStateAction<AssetItem[]>>;
  setTotalCount: React.Dispatch<React.SetStateAction<number>>;
}

interface Options extends AssetLibraryQuery {
  /** 弹窗、抽屉关闭时暂停请求；重新打开后自动恢复。 */
  enabled: boolean;
}

/** 内部列表状态；key 表示这份数据来自哪一个查询条件。 */
interface AssetListState {
  key: string;
  items: AssetItem[];
  totalCount: number;
}

const SEARCH_DEBOUNCE_MS = 300;

export function useAssetLibrary({ enabled, scope, folderId, search, categories }: Options): AssetLibraryState {
  const [listState, setListState] = useState<AssetListState>({ key: "", items: [], totalCount: 0 });
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);
  /** 最近一次首页请求失败的条件及当时的刷新令牌；retry 自增令牌后旧错误自动失效。 */
  const [errorState, setErrorState] = useState<{ key: string; token: number } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [debouncedSearch, setDebouncedSearch] = useState(search);

  const versionRef = useRef(0);
  const listStateRef = useRef(listState);
  const categoriesKey = useMemo(() => [...categories].sort().join(","), [categories]);
  const stableCategories = useMemo<AssetType[]>(
    () => (categoriesKey ? categoriesKey.split(",") as AssetType[] : []),
    [categoriesKey],
  );
  const isRootBrowse = folderId === null && !debouncedSearch.trim() && categories.length === 0;
  const queryKey = useMemo(
    () => [scope, folderId ?? "root", debouncedSearch, categoriesKey].join("\u0000"),
    [categoriesKey, folderId, scope, debouncedSearch],
  );
  const requestArgs = useMemo(
    () => ({
      scope,
      folderId: folderId ?? undefined,
      search: debouncedSearch,
      category: stableCategories.length > 0 ? stableCategories : "all",
    }),
    [folderId, scope, debouncedSearch, stableCategories],
  );

  // 搜索输入先防抖再进入 query key；输入期间沿用旧结果，不打断浏览。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // 镜像最新列表供查询 effect 在 query key 变化时读取（该 effect 不把 listState 列入依赖）。
  useEffect(() => {
    listStateRef.current = listState;
  }, [listState]);

  /** 更新当前 query key 的列表；条件已变化时丢弃本地更新，避免污染另一个查询。 */
  const setItems = useCallback<React.Dispatch<React.SetStateAction<AssetItem[]>>>(
    (action) => {
      setListState((state) => {
        if (state.key !== queryKey) return state;
        const nextItems = typeof action === "function" ? action(state.items) : action;
        return { ...state, items: nextItems };
      });
    },
    [queryKey],
  );

  /** 更新当前 query key 的总数；规则与 setItems 相同。 */
  const setTotalCount = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (action) => {
      setListState((state) => {
        if (state.key !== queryKey) return state;
        const nextTotalCount = typeof action === "function" ? action(state.totalCount) : action;
        return { ...state, totalCount: nextTotalCount };
      });
    },
    [queryKey],
  );

  // 条件变化即请求；搜索已在进入 query key 前完成防抖，这里不再二次延迟。
  useEffect(() => {
    versionRef.current += 1;
    if (!enabled) {
      return;
    }

    if (isRootBrowse) {
      // 根目录只展示文件夹：清空资产列表，避免离开根目录后旧文件夹内容被当作占位闪现。
      if (listStateRef.current.key !== queryKey || listStateRef.current.items.length > 0) {
        setListState({ key: queryKey, items: [], totalCount: 0 });
      }
      return;
    }

    const version = ++versionRef.current;

    void fetchAssetPage(requestArgs, 0)
      .then((result) => {
        if (version !== versionRef.current) return;
        setErrorState(null);
        setListState({ key: queryKey, items: result.items, totalCount: result.total });
      })
      .catch(() => {
        if (version !== versionRef.current) return;
        setErrorState({ key: queryKey, token: refreshToken });
      });
  }, [enabled, isRootBrowse, queryKey, refreshToken, requestArgs]);

  /** 追加下一页；筛选时忽略文件夹层级，与搜索的目录语义保持一致。 */
  const loadMore = useCallback(() => {
    if (!enabled || isRootBrowse || listState.key !== queryKey || loadingMoreKey === queryKey) return;
    const version = ++versionRef.current;
    setLoadingMoreKey(queryKey);

    void fetchAssetPage(requestArgs, listState.items.length)
      .then((result) => {
        if (version === versionRef.current) {
          setErrorState(null);
          setListState((state) => (
            state.key === queryKey
              ? { ...state, items: [...state.items, ...result.items], totalCount: result.total }
              : state
          ));
        }
      })
      .catch(() => {
        if (version === versionRef.current) setErrorState({ key: queryKey, token: refreshToken });
      })
      .finally(() => {
        setLoadingMoreKey((current) => (current === queryKey ? null : current));
      });
  }, [enabled, isRootBrowse, listState, loadingMoreKey, queryKey, refreshToken, requestArgs]);

  const reload = useCallback(() => setRefreshToken((token) => token + 1), []);

  /**
   * 删除后的本地同步：先乐观剔除并本地递减总数，再按删除条数拉取补偿页，
   * 让网格始终保持满页，不必等滚动到哨兵才补数据。
   * 不使用服务端 counters.total：那是全库总数，与当前筛选/文件夹视图无关。
   * 补偿失败不回滚（服务端已删除），哨兵仍可通过 loadMore 补齐。
   */
  const removeItems = useCallback(async (ids: string[]) => {
    if (listState.key !== queryKey) return;
    const idSet = new Set(ids);
    const removedInView = listState.items.filter((item) => idSet.has(item.id)).length;
    if (removedInView === 0) return;

    const remaining = listState.items.filter((item) => !idSet.has(item.id));
    const nextTotal = Math.max(0, listState.totalCount - removedInView);
    setListState({ key: queryKey, items: remaining, totalCount: nextTotal });

    if (remaining.length >= nextTotal) return;

    const version = ++versionRef.current;
    try {
      const result = await fetchAssetPage(requestArgs, remaining.length, removedInView);
      if (version !== versionRef.current) return;
      setErrorState(null);
      setListState((state) => {
        if (state.key !== queryKey) return state;
        const known = new Set(state.items.map((item) => item.id));
        const appended = result.items.filter((item) => !known.has(item.id));
        return { ...state, items: [...state.items, ...appended], totalCount: nextTotal };
      });
    } catch {
      if (version === versionRef.current) setErrorState({ key: queryKey, token: refreshToken });
    }
  }, [listState, queryKey, requestArgs, refreshToken]);

  const retry = useCallback(() => {
    if (listState.key === queryKey && listState.items.length > 0) loadMore();
    else reload();
  }, [listState.key, listState.items.length, queryKey, loadMore, reload]);

  // 新首页到达前 listState 仍是上一份结果，直接沿用展示；key 不匹配时只当占位，
  // hasMore 等交互状态仍只认当前 key。这样条件切换的第一帧也不会闪空态。
  const isQueryable = enabled && !isRootBrowse;
  const mismatched = listState.key !== queryKey;
  const failedCurrent = errorState?.key === queryKey && errorState.token === refreshToken;
  // 条件已变但当前 key 尚无归属结果即视为加载中（含查询 effect 执行前的那一帧）；
  // 当前 key 请求失败后解除，转入错误/重试态。
  const visibleLoading = isQueryable && mismatched && !failedCurrent;
  const visibleLoadingMore = isQueryable && loadingMoreKey === queryKey;
  // 失败且无任何列表可展示时才进入整页错误/重试态；有旧列表则保留浏览。
  const visibleLoadError = isQueryable && failedCurrent && listState.items.length === 0;
  const visibleItems = isQueryable ? listState.items : [];
  const visibleTotalCount = isQueryable ? listState.totalCount : 0;
  const visibleHasMore = !mismatched && listState.items.length < listState.totalCount;

  return {
    items: visibleItems,
    totalCount: visibleTotalCount,
    loading: visibleLoading,
    loadingMore: visibleLoadingMore,
    loadError: visibleLoadError,
    hasMore: visibleHasMore,
    reload,
    loadMore,
    retry,
    removeItems,
    setItems,
    setTotalCount,
  };
}
