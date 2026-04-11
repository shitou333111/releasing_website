import type { User as SupabaseAuthUser } from '@supabase/supabase-js';
import type { Annotation, User } from './types';
import { normalizePagePath } from './pagePath';
import { supabase } from './supabase';

const TABLE_ANNOTATIONS = 'annotations';
const TABLE_PROFILES = 'profiles';

type AnnotationRow = {
  id: string;
  page_path: string;
  creator_id: string;
  privacy: 'public' | 'private';
  payload: Annotation;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  name: string | null;
  avatar: string | null;
  updated_at: string;
};

function isValidAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Annotation;
  return (
    typeof maybe.id === 'string' &&
    typeof maybe.pagePath === 'string' &&
    typeof maybe.type === 'string' &&
    !!maybe.target &&
    Array.isArray(maybe.bodies) &&
    !!maybe.creator
  );
}

export async function fetchCloudAnnotations(pagePath: string): Promise<Annotation[]> {
  if (!supabase) return [];

  const normalizedPath = normalizePagePath(pagePath);
  const { data, error } = await supabase
    .from(TABLE_ANNOTATIONS)
    .select('payload,page_path')
    .eq('page_path', normalizedPath)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch cloud annotations:', error.message);
    return [];
  }

  return (data || [])
    .map((row: any) => row?.payload)
    .filter(isValidAnnotation)
    .map(annotation => ({
      ...annotation,
      pagePath: normalizePagePath(annotation.pagePath)
    }));
}

export async function upsertCloudAnnotation(annotation: Annotation, authUserId: string | null): Promise<boolean> {
  if (!supabase || !authUserId) return false;

  const normalizedPagePath = normalizePagePath(annotation.pagePath);
  const row: AnnotationRow = {
    id: annotation.id,
    page_path: normalizedPagePath,
    creator_id: authUserId,
    privacy: annotation.privacy,
    payload: {
      ...annotation,
      pagePath: normalizedPagePath
    },
    created_at: annotation.created,
    updated_at: annotation.modified || annotation.created
  };

  const { error } = await supabase.from(TABLE_ANNOTATIONS).upsert(row, { onConflict: 'id' });

  if (error) {
    console.error('Failed to upsert cloud annotation:', error.message);
    return false;
  }

  return true;
}

export async function deleteCloudAnnotation(annotationId: string, authUserId: string | null): Promise<boolean> {
  if (!supabase || !authUserId) return false;

  const { error } = await supabase
    .from(TABLE_ANNOTATIONS)
    .delete()
    .eq('id', annotationId)
    .eq('creator_id', authUserId);

  if (error) {
    console.error('Failed to delete cloud annotation:', error.message);
    return false;
  }

  return true;
}

export async function getCloudProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE_PROFILES)
    .select('id,name,avatar,updated_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch cloud profile:', error.message);
    return null;
  }

  return (data as ProfileRow | null) || null;
}

export async function getCloudProfileByName(name: string): Promise<ProfileRow | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE_PROFILES)
    .select('id,name,avatar,updated_at')
    .eq('name', name)
    .limit(1);

  if (error) {
    console.error('Failed to fetch cloud profile by name:', error.message);
    return null;
  }

  return (data?.[0] as ProfileRow | undefined) || null;
}

export async function ensureCloudProfile(authUser: SupabaseAuthUser, preferredName?: string): Promise<User> {
  if (!supabase) {
    return {
      id: authUser.id,
      name: preferredName || authUser.email || 'Cloud User',
      email: authUser.email,
      isAnonymous: false,
      authProvider: 'supabase'
    };
  }

  const existing = await getCloudProfile(authUser.id);
  const finalName =
    preferredName?.trim() ||
    existing?.name?.trim() ||
    authUser.user_metadata?.name ||
    authUser.email ||
    'Cloud User';

  const { error } = await supabase.from(TABLE_PROFILES).upsert({
    id: authUser.id,
    name: finalName,
    avatar: existing?.avatar || null,
    updated_at: new Date().toISOString()
  });

  if (error) {
    console.error('Failed to upsert cloud profile:', error.message);
  }

  return {
    id: authUser.id,
    name: finalName,
    avatar: existing?.avatar || undefined,
    email: authUser.email,
    isAnonymous: false,
    authProvider: 'supabase'
  };
}
