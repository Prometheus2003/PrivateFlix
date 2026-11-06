export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  count: number;
  parentId: string | null;
  coverMediaId: string | null;
  sortOrder: number;
}
