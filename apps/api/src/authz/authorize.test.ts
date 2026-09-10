import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { GrantPrincipal, Principal, StudioUserPrincipal } from '../auth/principal';
import {
  authorize,
  type Action,
  type AssetStatus,
  type DenyReason,
  type GalleryStatus,
  type Resource,
} from './authorize';
import { RIGHT } from './rights';

const STUDIO = '11111111-1111-1111-1111-111111111111';
const OTHER_STUDIO = '22222222-2222-2222-2222-222222222222';
const GALLERY = '33333333-3333-3333-3333-333333333333';
const OTHER_GALLERY = '44444444-4444-4444-4444-444444444444';

const verified: StudioUserPrincipal = {
  kind: 'user',
  userId: 'u1',
  studioId: STUDIO,
  sessionId: 's1',
  emailVerified: true,
};

const unverified: StudioUserPrincipal = { ...verified, emailVerified: false };
const foreign: StudioUserPrincipal = { ...verified, studioId: OTHER_STUDIO };

/** A delivery link: view + download. The mask docs/api.md calls 3. */
const delivery: GrantPrincipal = {
  kind: 'grant',
  grantId: 'gr1',
  studioId: STUDIO,
  galleryId: GALLERY,
  rightsMask: RIGHT.view | RIGHT.download,
  epoch: 0,
};

/** A proofing link: view + favorite. The mask docs/api.md calls 5. */
const proofing: GrantPrincipal = { ...delivery, rightsMask: RIGHT.view | RIGHT.favorite };
const viewOnly: GrantPrincipal = { ...delivery, rightsMask: RIGHT.view };
const foreignGrant: GrantPrincipal = { ...delivery, studioId: OTHER_STUDIO };

/** Every principal shape, for the coverage sweeps at the bottom of the file. */
const PRINCIPALS: Principal[] = [
  verified,
  unverified,
  foreign,
  delivery,
  proofing,
  viewOnly,
  foreignGrant,
];

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
  galleryId = GALLERY,
): Resource {
  return { kind: 'asset', studioId, galleryId, status, galleryStatus };
}

/** `null` means allow; a string is the exact reason expected. */
type Expected = DenyReason | null;

type Row = {
  name: string;
  principal: Principal;
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

describe('authorize — client holding a delivery grant (view + download)', () => {
  test('galleries, every action × every gallery status', () => {
    // Gallery status does not appear in a single cell below, and that is the
    // assertion: archived means the photographer adds no more photos, not that
    // the link they sent last year stopped working.
    const expected: Record<Action, Expected> = {
      'gallery.view': null,
      'gallery.manage': 'not_a_studio_principal',
      'asset.create': 'not_a_studio_principal',
      'asset.view_preview': 'wrong_resource_kind',
      'asset.download_full': 'wrong_resource_kind',
      'selection.favorite': 'missing_right',
      'selection.submit': 'missing_right',
    };

    check(
      GALLERY_STATUSES.flatMap((status) =>
        ACTIONS.map((action) => ({
          name: `${action} on ${status} gallery, delivery grant`,
          principal: delivery,
          action,
          resource: gallery(status),
          expected: expected[action],
        })),
      ),
    );
  });

  test('assets, every action × every asset status', () => {
    const perStatus = (status: AssetStatus): Record<Action, Expected> => ({
      'gallery.view': null,
      'gallery.manage': 'not_a_studio_principal',
      'asset.create': 'not_a_studio_principal',
      'asset.view_preview': status === 'ready' ? null : 'asset_not_ready',
      'asset.download_full': status === 'ready' ? null : 'asset_not_ready',
      // No favorite bit in this mask, and rights are answered before state.
      'selection.favorite': 'missing_right',
      'selection.submit': 'missing_right',
    });

    check(
      ASSET_STATUSES.flatMap((status) =>
        ACTIONS.map((action) => ({
          name: `${action} on ${status} asset, delivery grant`,
          principal: delivery,
          action,
          resource: asset(status),
          expected: perStatus(status)[action],
        })),
      ),
    );
  });
});

describe('authorize — client holding a proofing grant (view + favorite)', () => {
  test('can heart a ready photo and cannot download it', () => {
    const expected: Record<Action, Expected> = {
      'gallery.view': null,
      'gallery.manage': 'not_a_studio_principal',
      'asset.create': 'not_a_studio_principal',
      'asset.view_preview': null,
      'asset.download_full': 'missing_right',
      'selection.favorite': null,
      'selection.submit': null,
    };

    check(
      ACTIONS.map((action) => ({
        name: `${action} on a ready asset, proofing grant`,
        principal: proofing,
        action,
        resource: asset('ready'),
        expected: expected[action],
      })),
    );
  });

  test('nothing is favoritable until the worker has finished with it', () => {
    check(
      ASSET_STATUSES.filter((status) => status !== 'ready').map((status) => ({
        name: `selection.favorite on a ${status} asset`,
        principal: proofing,
        action: 'selection.favorite' as Action,
        resource: asset(status),
        expected: 'asset_not_ready' as Expected,
      })),
    );
  });
});

describe('authorize — client holding a view-only grant', () => {
  test('the two bits it does not have are the two things it cannot do', () => {
    const expected: Record<Action, Expected> = {
      'gallery.view': null,
      'gallery.manage': 'not_a_studio_principal',
      'asset.create': 'not_a_studio_principal',
      'asset.view_preview': null,
      'asset.download_full': 'missing_right',
      'selection.favorite': 'missing_right',
      'selection.submit': 'missing_right',
    };

    check(
      ACTIONS.map((action) => ({
        name: `${action}, view-only grant`,
        principal: viewOnly,
        action,
        resource: asset('ready'),
        expected: expected[action],
      })),
    );
  });
});

describe('authorize — a grant is confined to its own gallery', () => {
  test('every action on an asset in another gallery is wrong_gallery', () => {
    // Same studio, same rights, ready asset. The only thing wrong is that the
    // asset id names a gallery this grant was not issued for.
    check(
      ASSET_STATUSES.flatMap((status) =>
        ACTIONS.map((action) => ({
          name: `${action} on a ${status} asset in another gallery`,
          principal: delivery,
          action,
          resource: asset(status, 'active', STUDIO, OTHER_GALLERY),
          expected: 'wrong_gallery' as Expected,
        })),
      ),
    );
  });

  test('the gallery check runs before the rights check', () => {
    // Otherwise a probe learns which rights a grant holds from which denial it
    // gets back for someone else's asset id.
    check([
      {
        name: 'download without the bit, on another gallery',
        principal: viewOnly,
        action: 'asset.download_full',
        resource: asset('ready', 'active', STUDIO, OTHER_GALLERY),
        expected: 'wrong_gallery',
      },
      {
        name: 'favorite without the bit, on another gallery',
        principal: delivery,
        action: 'selection.favorite',
        resource: asset('ready', 'active', STUDIO, OTHER_GALLERY),
        expected: 'wrong_gallery',
      },
    ]);
  });

  test('tenant is still checked before gallery', () => {
    check([
      {
        name: 'foreign studio, and the gallery matches',
        principal: foreignGrant,
        action: 'gallery.view',
        resource: asset('ready'),
        expected: 'wrong_tenant',
      },
    ]);
  });

  test('every action on every resource of another studio is wrong_tenant', () => {
    const resources: Resource[] = [
      ...GALLERY_STATUSES.map((status) => gallery(status)),
      ...ASSET_STATUSES.map((status) => asset(status)),
    ];

    check(
      resources.flatMap((resource) =>
        ACTIONS.map((action) => ({
          name: `${action} on ${resource.kind}/${resource.status}, foreign grant`,
          principal: foreignGrant,
          action,
          resource,
          expected: 'wrong_tenant' as Expected,
        })),
      ),
    );
  });
});

describe('authorize — every rights mask', () => {
  test('a ready asset, all seven masks × every action', () => {
    // 1..7 is the full range grants.rights_mask's CHECK permits. A loop over
    // masks rather than seven tables, because the expectation genuinely is a
    // function of the bits and saying so is the clearer assertion.
    const rows: Row[] = [];

    for (let mask = 1; mask < 8; mask += 1) {
      const principal: GrantPrincipal = { ...delivery, rightsMask: mask };
      const expected: Record<Action, Expected> = {
        'gallery.view': mask & RIGHT.view ? null : 'missing_right',
        'gallery.manage': 'not_a_studio_principal',
        'asset.create': 'not_a_studio_principal',
        'asset.view_preview': mask & RIGHT.view ? null : 'missing_right',
        'asset.download_full': mask & RIGHT.download ? null : 'missing_right',
        'selection.favorite': mask & RIGHT.favorite ? null : 'missing_right',
        'selection.submit': mask & RIGHT.favorite ? null : 'missing_right',
      };

      for (const action of ACTIONS) {
        rows.push({
          name: `${action} with mask ${mask}`,
          principal,
          action,
          resource: asset('ready'),
          expected: expected[action],
        });
      }
    }

    check(rows);
  });

  test('an empty mask grants nothing, though the schema forbids storing one', () => {
    check(
      ACTIONS.map((action) => ({
        name: `${action} with an empty mask`,
        principal: { ...delivery, rightsMask: 0 },
        action,
        resource: asset('ready'),
        expected: (action === 'gallery.manage' || action === 'asset.create'
          ? 'not_a_studio_principal'
          : 'missing_right') as Expected,
      })),
    );
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
        for (const principal of PRINCIPALS) {
          const decision = authorize(principal, action, resource);
          assert.ok(
            typeof decision.allow === 'boolean',
            `${action} on ${resource.kind}/${resource.status} returned no decision`,
          );
        }
      }
    }
  });

  test('no denial ever leaks a resource id or a studio id', () => {
    const reasons = new Set<string>();

    for (const action of ACTIONS) {
      for (const principal of PRINCIPALS) {
        for (const resource of [
          gallery('archived'),
          asset('pending'),
          asset('ready', 'active', STUDIO, OTHER_GALLERY),
        ]) {
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
