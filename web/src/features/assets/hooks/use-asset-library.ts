/**
 * 资产库查询 Hook。
 * 资产弹窗与画布抽屉共用同一条查询链路，避免两处各自维护搜索、筛选、分页和竞态规则。
 * 根目录规则：无搜索且无分类筛选时只展示文件夹；有搜索或筛选时跨全部资产查询。
 * 列表结果必须归属当前 query key：切换筛选后不展示旧条件的数据，避免分类间闪现错列表。
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

export function useAssetLibrary({ enabled, scope, folderId, search, categories }: Options): AssetLibraryState {
  const [listState, setListState] = useState<AssetListState>({ key: "", items: [], totalCount: 0 });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const versionRef = useRef(0);
  const categoriesKey = useMemo(() => [...categories].sort().join(","), [categories]);
  const stableCategories = useMemo<AssetType[]>(
    () => (categoriesKey ? categoriesKey.split(",") as AssetType[] : []),
    [categoriesKey],
  );
  const isRootBrowse = folderId === null && !search.trim() && categories.length === 0;
  const queryKey = useMemo(
    () => [scope, folderId ?? "root", search, categoriesKey].join("\u0000"),
    [categoriesKey, folderId, scope, search],
  );
  const requestArgs = useMemo(
    () => ({
      scope,
      folderId: folderId ?? undefined,
      search,
      category: stableCategories.length > 0 ? stableCategories : "all",
    }),
    [folderId, scope, search, stableCategories],
  );

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

  // 防抖后执行首页查询；每次条件变化先递增版本号，让仍在路上的旧请求全部失效。
  useEffect(() => {
    versionRef.current += 1;
    if (!enabled || isRootBrowse) {
      return;
    }

    const timer = setTimeout(() => {
      const version = ++versionRef.current;
      setPendingKey(queryKey);
      setErrorKey(null);

      void fetchAssetPage(requestArgs, 0)
        .then((result) => {
          if (version !== versionRef.current) return;
          setListState({ key: queryKey, items: result.items, totalCount: result.total });
          setPendingKey(null);
        })
        .catch(() => {
          if (version !== versionRef.current) return;
          setErrorKey(queryKey);
          setPendingKey(null);
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [enabled, isRootBrowse, queryKey, refreshToken, requestArgs]);

  /** 追加下一页；筛选时忽略文件夹层级，与搜索的目录语义保持一致。 */
  const loadMore = useCallback(() => {
    if (!enabled || isRootBrowse || listState.key !== queryKey || pendingKey === queryKey) return;
    const version = ++versionRef.current;
    setLoadingMoreKey(queryKey);
    setErrorKey(null);

    void fetchAssetPage(requestArgs, listState.items.length)
      .then((result) => {
        if (version === versionRef.current) {
          setListState((state) => (
            state.key === queryKey
              ? { ...state, items: [...state.items, ...result.items], totalCount: result.total }
              : state
          ));
        }
      })
      .catch(() => {
        if (version === versionRef.current) setErrorKey(queryKey);
      })
      .finally(() => {
        setLoadingMoreKey((current) => (current === queryKey ? null : current));
      });
  }, [enabled, isRootBrowse, listState, pendingKey, queryKey, requestArgs]);

  const reload = useCallback(() => setRefreshToken((token) => token + 1), []);

  // 只有当前 key 拥有结果时才渲染列表；条件刚变化时立即显示 loading，而不是闪现旧分类列表。
  const isQueryable = enabled && !isRootBrowse;
  const hasCurrentResult = listState.key === queryKey;
  const visibleItems = isQueryable && hasCurrentResult ? listState.items : [];
  const visibleTotalCount = isQueryable && hasCurrentResult ? listState.totalCount : 0;
  const visibleLoading = isQueryable && (pendingKey === queryKey || !hasCurrentResult);
  const visibleLoadingMore = isQueryable && loadingMoreKey === queryKey;
  const visibleLoadError = isQueryable && errorKey === queryKey;

  return {
    items: visibleItems,
    totalCount: visibleTotalCount,
    loading: visibleLoading,
    loadingMore: visibleLoadingMore,
    loadError: visibleLoadError,
    hasMore: hasCurrentResult && visibleItems.length < visibleTotalCount,
    reload,
    loadMore,
    setItems,
    setTotalCount,
  };
}
