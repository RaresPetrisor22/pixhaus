import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StudioUserPrincipal } from '../auth/principal';
import {
  authorize,
  type Action,
  type AssetStatus,
  type DenyReason,
  type GalleryStatus,
  type Resource,
} from './authorize';

const STUDIO = '11111111-1111-1111-1111-111111111111';
const OTHER_STUDIO = '22222222-2222-2222-2222-222222222222';

const verified: StudioUserPrincipal = {
  kind: 'user',
  userId: 'u1',
  studioId: STUDIO,
  sessionId: 's1',
  emailVerified: true,
};

const unverified: StudioUserPrincipal = { ...verified, emailVerified: false };
const foreign: StudioUserPrincipal = { ...verified, studioId: OTHER_STUDIO };

const GALLERY_STATUSES: GalleryStatus[] = ['draft', 'active', 'archived'];
const ASSET_STATUSES: AssetStatus[] = [
  'pending',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'orphaned',
];

const ACTIONS: Action[] = [
  'gallery.view',
  'gallery.manage',
  'asset.create',
  'asset.view_preview',
  'asset.download_full',
  'selection.favorite',
  'selection.submit',
];

function gallery(status: GalleryStatus, studioId = STUDIO): Resource {
  return { kind: 'gallery', studioId, status };
}

function asset(
  status: AssetStatus,
  galleryStatus: GalleryStatus = 'active',
  studioId = STUDIO,
): Resource {
  return { kind: 'asset', studioId, status, galleryStatus };
}

/** `null` means allow; a string is the exact reason expected. */
type Expected = DenyReason | null;

type Row = {
  name: string;
  principal: StudioUserPrincipal;
  action: Action;
  resource: Resource;
  expected: Expected;
};

function check(rows: Row[]): void {
  for (const row of rows) {
    const decision = authorize(row.principal, row.action, row.resource);

    if (row.expected === null) {
      assert.equal(decision.allow, true, `${row.name}: expected allow, got deny`);
    } else {
      assert.equal(decision.allow, false, `${row.name}: expected deny, got allow`);
      assert.equal(
        decision.allow === false ? decision.reason : undefined,
        row.expected,
        `${row.name}: wrong reason`,
      );
    }
  }
}

describe('authorize — verified photographer, own studio', () => {
  test('galleries, every action × every gallery status', () => {
    const expected: Record<GalleryStatus, Record<Action, Expected>> = {
      draft: {
        'gallery.view': null,
        'gallery.manage': null,
        'asset.create': null,
        'asset.view_preview': 'wrong_resource_kind',
        'asset.download_full': 'wrong_resource_kind',
        'selection.favorite': 'not_a_client_principal',
        'selection.submit': 'not_a_client_principal',
      },
      active: {
        'gallery.view': null,
        'gallery.manage': null,
        'asset.create': null,
        'asset.view_preview': 'wrong_resource_kind',
        'asset.download_full': 'wrong_resource_kind',
        'selection.favorite': 'not_a_client_principal',
        'selection.submit': 'not_a_client_principal',
      },
      // Archived: no new photos go in. `gallery.manage` stays allowed, or
      // un-archiving would be impossible.
      archived: {
        'gallery.view': null,
        'gallery.manage': null,
        'asset.create': 'gallery_archived',
        'asset.view_preview': 'wrong_resource_kind',
        'asset.download_full': 'wrong_resource_kind',
        'selection.favorite': 'not_a_client_principal',
        'selection.submit': 'not_a_client_principal',
      },
    };

    check(
      GALLERY_STATUSES.flatMap((status) =>
        ACTIONS.map((action) => ({
          name: `${action} on ${status} gallery`,
          principal: verified,
          action,
          resource: gallery(status),
          expected: expected[status][action],
        })),
      ),
    );
  });

  test('assets, every action × every asset status', () => {
    // Only a `ready` asset has renditions to preview and a verified original to
    // download. Every other status is a photo that is not there yet.
    const perStatus = (status: AssetStatus): Record<Action, Expected> => ({
      'gallery.view': null,
      'gallery.manage': 'wrong_resource_kind',
      'asset.create': 'wrong_resource_kind',
      'asset.view_preview': status === 'ready' ? null : 'asset_not_ready',
      'asset.download_full': status === 'ready' ? null : 'asset_not_ready',
      'selection.favorite': 'not_a_client_principal',
      'selection.submit': 'not_a_client_principal',
    });

    check(
      ASSET_STATUSES.flatMap((status) =>
        ACTIONS.map((action) => ({
          name: `${action} on ${status} asset`,
          principal: verified,
          action,
          resource: asset(status),
          expected: perStatus(status)[action],
        })),
      ),
    );
  });

  test('a ready asset in an archived gallery is still viewable and downloadable', () => {
    check([
      {
        name: 'view_preview, archived gallery',
        principal: verified,
        action: 'asset.view_preview',
        resource: asset('ready', 'archived'),
        expected: null,
      },
      {
        name: 'download_full, archived gallery',
        principal: verified,
        action: 'asset.download_full',
        resource: asset('ready', 'archived'),
        expected: null,
      },
    ]);
  });

  test('archiving is not a one-way door', () => {
    // The regression this guards: denying gallery.manage on an archived gallery
    // reads as "read-only" and is wrong, because un-archiving IS a manage.
    check([
      {
        name: 'gallery.manage on an archived gallery',
        principal: verified,
        action: 'gallery.manage',
        resource: gallery('archived'),
        expected: null,
      },
    ]);
  });
});

describe('authorize — unverified photographer', () => {
  test('reads pass, writes do not', () => {
    const expected: Record<Action, Expected> = {
      'gallery.view': null,
      'gallery.manage': 'email_unverified',
      'asset.create': 'email_unverified',
      'asset.view_preview': 'wrong_resource_kind',
      'asset.download_full': 'wrong_resource_kind',
      'selection.favorite': 'not_a_client_principal',
      'selection.submit': 'not_a_client_principal',
    };

    check(
      ACTIONS.map((action) => ({
        name: `${action}, unverified`,
        principal: unverified,
        action,
        resource: gallery('active'),
        expected: expected[action],
      })),
    );
  });

  test('unverified beats archived — the account is the earlier problem', () => {
    check([
      {
        name: 'asset.create on an archived gallery, unverified',
        principal: unverified,
        action: 'asset.create',
        resource: gallery('archived'),
        expected: 'email_unverified',
      },
    ]);
  });

  test('can still see a ready asset', () => {
    check([
      {
        name: 'asset.view_preview, unverified',
        principal: unverified,
        action: 'asset.view_preview',
        resource: asset('ready'),
        expected: null,
      },
    ]);
  });
});

describe('authorize — another studio', () => {
  test('every action on every resource is wrong_tenant, verified or not', () => {
    const resources: Resource[] = [
      ...GALLERY_STATUSES.map((status) => gallery(status)),
      ...ASSET_STATUSES.map((status) => asset(status)),
    ];

    check(
      resources.flatMap((resource) =>
        ACTIONS.map((action) => ({
          name: `${action} on ${resource.kind}/${resource.status}, foreign studio`,
          principal: foreign,
          action,
          resource,
          expected: 'wrong_tenant' as Expected,
        })),
      ),
    );
  });

  test('tenant is checked before everything else, including verification', () => {
    check([
      {
        name: 'unverified AND foreign',
        principal: { ...unverified, studioId: OTHER_STUDIO },
        action: 'asset.create',
        resource: gallery('active'),
        expected: 'wrong_tenant',
      },
    ]);
  });
});

describe('authorize — coverage', () => {
  test('every action appears in the matrix for every resource shape', () => {
    // Guards the table against an action being added to the vocabulary and
    // silently never asserted.
    const resources: Resource[] = [
      ...GALLERY_STATUSES.map((status) => gallery(status)),
      ...ASSET_STATUSES.flatMap((status) =>
        GALLERY_STATUSES.map((galleryStatus) => asset(status, galleryStatus)),
      ),
    ];

    for (const action of ACTIONS) {
      for (const resource of resources) {
        const decision = authorize(verified, action, resource);
        assert.ok(
          typeof decision.allow === 'boolean',
          `${action} on ${resource.kind}/${resource.status} returned no decision`,
        );
      }
    }
  });

  test('no denial ever leaks a resource id or a studio id', () => {
    const reasons = new Set<string>();

    for (const action of ACTIONS) {
      for (const principal of [verified, unverified, foreign]) {
        for (const resource of [gallery('archived'), asset('pending')]) {
          const decision = authorize(principal, action, resource);
          if (decision.allow === false) {
            reasons.add(decision.reason);
          }
        }
      }
    }

    for (const reason of reasons) {
      assert.doesNotMatch(reason, /[0-9a-f]{8}-/, `reason "${reason}" contains an id`);
    }
  });
});
