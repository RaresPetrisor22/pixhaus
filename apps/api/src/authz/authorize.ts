import type { StudioUserPrincipal } from '../auth/principal';

/** M3: `| GrantPrincipal`. */
export type Principal = StudioUserPrincipal;

/**
 * The complete action vocabulary, from `docs/api.md`.
 */
export type Action =
  | 'gallery.view'
  | 'gallery.manage'
  | 'asset.create'
  | 'asset.view_preview'
  | 'asset.download_full'
  | 'selection.favorite'
  | 'selection.submit';

export type GalleryStatus = 'draft' | 'active' | 'archived';

export type AssetStatus = 'pending' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'orphaned';

/**
 * What the caller loaded, reduced to the fields that bear on a decision.
 */
export type Resource =
  | { kind: 'gallery'; studioId: string; status: GalleryStatus }
  | {
      kind: 'asset';
      studioId: string;
      status: AssetStatus;
      galleryStatus: GalleryStatus;
    };

/**
 * A reason on every denial, and it is for the logs and the tests
 */
export type Decision = { allow: true } | { allow: false; reason: DenyReason };

export type DenyReason =
  | 'wrong_tenant'
  | 'email_unverified'
  | 'gallery_archived'
  | 'asset_not_ready'
  | 'wrong_resource_kind'
  | 'not_a_client_principal';

const ALLOW: Decision = { allow: true };

function deny(reason: DenyReason): Decision {
  return { allow: false, reason };
}

/**
 * Actions that write. These require a verified email address; reads do not.
 */
const WRITES_TO_THE_GALLERY: ReadonlySet<Action> = new Set<Action>([
  'gallery.manage',
  'asset.create',
]);

export function authorize(principal: Principal, action: Action, resource: Resource): Decision {
  // If this ever fires, something upstream loaded a row it
  // had no business seeing
  if (principal.studioId !== resource.studioId) {
    return deny('wrong_tenant');
  }

  const galleryStatus = resource.kind === 'gallery' ? resource.status : resource.galleryStatus;

  if (WRITES_TO_THE_GALLERY.has(action) && !principal.emailVerified) {
    return deny('email_unverified');
  }

  // Archived means "no new photos go in".
  if (action === 'asset.create' && galleryStatus === 'archived') {
    return deny('gallery_archived');
  }

  switch (action) {
    case 'gallery.view':
      return ALLOW;

    case 'gallery.manage':
      return resource.kind === 'gallery' ? ALLOW : deny('wrong_resource_kind');

    case 'asset.create':
      return resource.kind === 'gallery' ? ALLOW : deny('wrong_resource_kind');

    case 'asset.view_preview':
    case 'asset.download_full':
      if (resource.kind !== 'asset') {
        return deny('wrong_resource_kind');
      }
      return resource.status === 'ready' ? ALLOW : deny('asset_not_ready');

    case 'selection.favorite':
    case 'selection.submit':
      return deny('not_a_client_principal');
  }
}
