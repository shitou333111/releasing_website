import { supabase } from '../utils/supabase';
import {
  type CreateTreeHoleReplyInput,
  type CreateTreeHoleThreadInput,
  type TreeHoleImage,
  type TreeHoleReceivedReply,
  type TreeHoleReply,
  type TreeHoleThreadCard,
  type TreeHoleThreadDetail,
  type TreeHoleView
} from '../types/treehole';

const TABLE_THREAD_CARDS = 'treehole_thread_cards';
const TABLE_THREADS = 'treehole_threads';
const TABLE_REPLIES = 'treehole_replies';
const TABLE_FAVORITES = 'treehole_favorites';
const TABLE_IMAGES = 'treehole_images';
const IMAGE_BUCKET = 'treehole-images';

function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase 未配置，TreeHole 功能不可用');
  }

  return supabase;
}

type ThreadCardRow = {
  id: string;
  thread_no: string;
  title: string;
  content: string;
  creator_id: string;
  creator_alias_label: string;
  visibility: 'public' | 'private';
  status: 'open' | 'closed' | 'deleted';
  created_at: string;
  updated_at: string;
  reply_count: number;
  favorite_count: number;
};

type ReplyRow = {
  id: string;
  thread_id: string;
  author_id: string;
  author_alias_label: string;
  content: string;
  created_at: string;
  updated_at: string;
};

type ImageRow = {
  id: string;
  thread_id: string | null;
  reply_id: string | null;
  public_url: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

function mapImage(row: ImageRow): TreeHoleImage {
  return {
    id: row.id,
    threadId: row.thread_id,
    replyId: row.reply_id,
    publicUrl: row.public_url,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at
  };
}

function mapThreadCard(row: ThreadCardRow): TreeHoleThreadCard {
  return {
    id: row.id,
    threadNo: row.thread_no,
    title: row.title,
    content: row.content,
    creatorId: row.creator_id,
    creatorAlias: row.creator_alias_label,
    visibility: row.visibility,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    replyCount: Number(row.reply_count || 0),
    favoriteCount: Number(row.favorite_count || 0),
    isFavorited: false,
    images: []
  };
}

function mapReply(row: ReplyRow): TreeHoleReply {
  return {
    id: row.id,
    threadId: row.thread_id,
    authorId: row.author_id,
    authorAlias: row.author_alias_label,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    images: []
  };
}

function toSafeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function fetchFavoritedThreadIds(userId: string, threadIds: string[]): Promise<Set<string>> {
  if (!threadIds.length) {
    return new Set();
  }

  const client = requireSupabase();
  const { data, error } = await client
    .from(TABLE_FAVORITES)
    .select('thread_id')
    .eq('user_id', userId)
    .in('thread_id', threadIds);

  if (error) {
    throw new Error(error.message);
  }

  return new Set((data || []).map((item: any) => item.thread_id as string));
}

async function fetchThreadImages(threadIds: string[]): Promise<Map<string, TreeHoleImage[]>> {
  const result = new Map<string, TreeHoleImage[]>();
  if (!threadIds.length) {
    return result;
  }

  const client = requireSupabase();
  const { data, error } = await client
    .from(TABLE_IMAGES)
    .select('id,thread_id,reply_id,public_url,storage_path,mime_type,size_bytes,created_at')
    .in('thread_id', threadIds)
    .is('reply_id', null)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  (data || []).forEach((row: any) => {
    const image = mapImage(row as ImageRow);
    const threadId = image.threadId;
    if (!threadId) return;

    const list = result.get(threadId) || [];
    list.push(image);
    result.set(threadId, list);
  });

  return result;
}

export async function fetchTreeHoleThreads(
  view: Extract<TreeHoleView, 'all' | 'mine' | 'favorites'>,
  userId: string | null,
  limit = 10,
  offset = 0
): Promise<TreeHoleThreadCard[]> {
  const client = requireSupabase();

  let threadIdsForFavorites: string[] = [];
  if (view === 'favorites') {
    if (!userId) return [];

    const favoriteRows = await client
      .from(TABLE_FAVORITES)
      .select('thread_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (favoriteRows.error) {
      throw new Error(favoriteRows.error.message);
    }

    threadIdsForFavorites = (favoriteRows.data || []).map((row: any) => row.thread_id as string);
    if (!threadIdsForFavorites.length) {
      return [];
    }
  }

  let query = client
    .from(TABLE_THREAD_CARDS)
    .select('id,thread_no,title,content,creator_id,creator_alias_label,visibility,status,created_at,updated_at,reply_count,favorite_count')
    .neq('status', 'deleted')
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (view === 'mine') {
    if (!userId) return [];
    query = query.eq('creator_id', userId);
  } else if (view === 'favorites') {
    query = query.in('id', threadIdsForFavorites);
  } else {
    query = query.eq('visibility', 'public');
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const cards = (data || []).map((row: any) => mapThreadCard(row as ThreadCardRow));

  const ids = cards.map((item) => item.id);
  const imageMap = await fetchThreadImages(ids);
  let favorited = new Set<string>();

  if (userId) {
    favorited = await fetchFavoritedThreadIds(userId, ids);
  }

  return cards.map((card) => ({
    ...card,
    isFavorited: favorited.has(card.id),
    images: imageMap.get(card.id) || []
  }));
}

async function fetchReplyImages(replyIds: string[]): Promise<Map<string, TreeHoleImage[]>> {
  const result = new Map<string, TreeHoleImage[]>();
  if (!replyIds.length) {
    return result;
  }

  const client = requireSupabase();
  const { data, error } = await client
    .from(TABLE_IMAGES)
    .select('id,thread_id,reply_id,public_url,storage_path,mime_type,size_bytes,created_at')
    .in('reply_id', replyIds)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  (data || []).forEach((row: any) => {
    const image = mapImage(row as ImageRow);
    const replyId = image.replyId;
    if (!replyId) return;

    const list = result.get(replyId) || [];
    list.push(image);
    result.set(replyId, list);
  });

  return result;
}

export async function fetchTreeHoleThreadDetail(threadId: string, userId: string | null): Promise<TreeHoleThreadDetail | null> {
  const client = requireSupabase();

  const { data: threadData, error: threadError } = await client
    .from(TABLE_THREAD_CARDS)
    .select('id,thread_no,title,content,creator_id,creator_alias_label,visibility,status,created_at,updated_at,reply_count,favorite_count')
    .eq('id', threadId)
    .maybeSingle();

  if (threadError) {
    throw new Error(threadError.message);
  }

  if (!threadData) {
    return null;
  }

  const thread = mapThreadCard(threadData as ThreadCardRow);

  if (userId) {
    const favorited = await fetchFavoritedThreadIds(userId, [thread.id]);
    thread.isFavorited = favorited.has(thread.id);
  }

  const threadImageMap = await fetchThreadImages([thread.id]);
  thread.images = threadImageMap.get(thread.id) || [];

  const { data: replyRows, error: replyError } = await client
    .from(TABLE_REPLIES)
    .select('id,thread_id,author_id,author_alias_label,content,created_at,updated_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (replyError) {
    throw new Error(replyError.message);
  }

  const replies = (replyRows || []).map((row: any) => mapReply(row as ReplyRow));
  const replyImages = await fetchReplyImages(replies.map((reply) => reply.id));

  replies.forEach((reply) => {
    reply.images = replyImages.get(reply.id) || [];
  });

  return {
    thread,
    replies
  };
}

export async function fetchTreeHoleThreadIdByNo(threadNo: string): Promise<string | null> {
  const client = requireSupabase();

  const normalized = threadNo.trim();
  if (!normalized) {
    return null;
  }

  const { data, error } = await client
    .from(TABLE_THREAD_CARDS)
    .select('id')
    .eq('thread_no', normalized)
    .neq('status', 'deleted')
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data?.id || null;
}

export async function fetchReceivedReplies(userId: string, limit = 50): Promise<TreeHoleReceivedReply[]> {
  const client = requireSupabase();

  const { data, error } = await client
    .from(TABLE_REPLIES)
    .select('id,thread_id,author_id,author_alias_label,content,created_at,thread:treehole_threads!inner(id,thread_no,title,creator_id)')
    .eq('thread.creator_id', userId)
    .neq('author_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    threadId: row.thread_id,
    threadNo: row.thread?.thread_no || '',
    threadTitle: row.thread?.title || '未知帖子',
    authorId: row.author_id,
    authorAlias: row.author_alias_label,
    content: row.content,
    createdAt: row.created_at
  }));
}

async function uploadImages(
  ownerId: string,
  threadId: string,
  replyId: string | null,
  files: File[]
): Promise<TreeHoleImage[]> {
  const client = requireSupabase();
  const created: TreeHoleImage[] = [];

  for (const file of files) {
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
    const entity = replyId ? `reply-${replyId}` : 'thread';
    const filePath = `${ownerId}/${threadId}/${entity}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${toSafeFileName(file.name || `file.${ext || 'bin'}`)}`;

    const uploadRes = await client.storage.from(IMAGE_BUCKET).upload(filePath, file, {
      upsert: false,
      contentType: file.type || 'application/octet-stream'
    });

    if (uploadRes.error) {
      throw new Error(uploadRes.error.message);
    }

    const publicRes = client.storage.from(IMAGE_BUCKET).getPublicUrl(filePath);
    const publicUrl = publicRes.data.publicUrl;

    const { data: imageRow, error: imageError } = await client
      .from(TABLE_IMAGES)
      .insert({
        thread_id: threadId,
        reply_id: replyId,
        owner_id: ownerId,
        storage_path: filePath,
        public_url: publicUrl,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size
      })
      .select('id,thread_id,reply_id,public_url,storage_path,mime_type,size_bytes,created_at')
      .single();

    if (imageError) {
      throw new Error(imageError.message);
    }

    created.push(mapImage(imageRow as ImageRow));
  }

  return created;
}

export async function createTreeHoleThread(input: CreateTreeHoleThreadInput, userId: string): Promise<string> {
  const client = requireSupabase();

  const { data, error } = await client.rpc('treehole_create_thread', {
    p_title: input.title,
    p_content: input.content,
    p_visibility: input.visibility
  });

  if (error) {
    throw new Error(error.message);
  }

  const threadId = String(data || '');
  if (!threadId) {
    throw new Error('创建帖子失败，未返回帖子ID');
  }

  if (input.images.length) {
    await uploadImages(userId, threadId, null, input.images);
  }

  return threadId;
}

export async function createTreeHoleReply(input: CreateTreeHoleReplyInput, userId: string): Promise<string> {
  const client = requireSupabase();

  const { data, error } = await client.rpc('treehole_create_reply', {
    p_thread_id: input.threadId,
    p_content: input.content
  });

  if (error) {
    throw new Error(error.message);
  }

  const replyId = String(data || '');
  if (!replyId) {
    throw new Error('发送回复失败，未返回回复ID');
  }

  if (input.images.length) {
    await uploadImages(userId, input.threadId, replyId, input.images);
  }

  return replyId;
}

export async function setThreadFavorite(threadId: string, userId: string, shouldFavorite: boolean): Promise<void> {
  const client = requireSupabase();

  if (shouldFavorite) {
    const { error } = await client
      .from(TABLE_FAVORITES)
      .upsert({ user_id: userId, thread_id: threadId }, { onConflict: 'user_id,thread_id', ignoreDuplicates: true });

    if (error) {
      throw new Error(error.message);
    }

    return;
  }

  const { error } = await client
    .from(TABLE_FAVORITES)
    .delete()
    .eq('user_id', userId)
    .eq('thread_id', threadId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function closeTreeHoleThread(threadId: string, userId: string): Promise<void> {
  const client = requireSupabase();

  const { error } = await client
    .from(TABLE_THREADS)
    .update({ status: 'closed', updated_at: new Date().toISOString() })
    .eq('id', threadId)
    .eq('creator_id', userId);

  if (error) {
    throw new Error(error.message);
  }
}
