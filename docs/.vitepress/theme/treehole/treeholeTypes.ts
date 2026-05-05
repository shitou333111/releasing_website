export type TreeHoleView = 'all' | 'mine' | 'favorites' | 'replies';

export interface TreeHoleImage {
  id: string;
  threadId: string | null;
  replyId: string | null;
  publicUrl: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TreeHoleThreadCard {
  id: string;
  threadNo: string;
  title: string;
  content: string;
  creatorId: string;
  creatorAlias: string;
  visibility: 'public' | 'private';
  status: 'open' | 'closed' | 'deleted';
  createdAt: string;
  updatedAt: string;
  replyCount: number;
  favoriteCount: number;
  isFavorited: boolean;
  images: TreeHoleImage[];
}

export interface TreeHoleReply {
  id: string;
  threadId: string;
  authorId: string;
  authorAlias: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  images: TreeHoleImage[];
}

export interface TreeHoleThreadDetail {
  thread: TreeHoleThreadCard;
  replies: TreeHoleReply[];
}

export interface TreeHoleReceivedReply {
  id: string;
  threadId: string;
  threadNo: string;
  threadTitle: string;
  authorId: string;
  authorAlias: string;
  content: string;
  createdAt: string;
}

export interface CreateTreeHoleThreadInput {
  title: string;
  content: string;
  visibility: 'public' | 'private';
  images: File[];
}

export interface CreateTreeHoleReplyInput {
  threadId: string;
  content: string;
  images: File[];
}
