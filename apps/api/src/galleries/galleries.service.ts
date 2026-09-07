import { HttpStatus, Injectable } from '@nestjs/common';

import type { StudioUserPrincipal } from '../auth/principal';
import { authorize, type Action, type Resource } from '../authz/authorize';
import { ApiException } from '../common/api-exception';
import { GalleriesRepository, type Gallery, type GalleryPage } from './galleries.repository';
import type {
  CreateGalleryInput,
  ListGalleriesInput,
  UpdateGalleryInput,
} from './galleries.schemas';

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'gallery_not_found', 'No such gallery.');
}

/** Denials that are the caller's to fix get their own code; the rest are 403. */
function denied(reason: string): ApiException {
  if (reason === 'email_unverified') {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'email_unverified',
      'Verify your email address before creating or changing galleries.',
    );
  }

  if (reason === 'gallery_archived') {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'gallery_archived',
      'This gallery is archived. Un-archive it first.',
    );
  }

  return new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
}

@Injectable()
export class GalleriesService {
  constructor(private readonly repository: GalleriesRepository) {}

  private must(principal: StudioUserPrincipal, action: Action, resource: Resource): void {
    const decision = authorize(principal, action, resource);

    if (!decision.allow) {
      throw denied(decision.reason);
    }
  }

  private asResource(gallery: Gallery, studioId: string): Resource {
    return { kind: 'gallery', studioId, status: gallery.status };
  }

  async create(principal: StudioUserPrincipal, input: CreateGalleryInput): Promise<Gallery> {
    // The gallery does not exist yet, so authorize() is asked about the one
    // about to be created. `draft` is what the schema defaults it to.
    this.must(principal, 'gallery.manage', {
      kind: 'gallery',
      studioId: principal.studioId,
      status: 'draft',
    });

    return this.repository.create(principal.studioId, input.title);
  }

  list(principal: StudioUserPrincipal, query: ListGalleriesInput): Promise<GalleryPage> {
    return this.repository.list(principal.studioId, query.limit, query.cursor);
  }

  async findOne(principal: StudioUserPrincipal, galleryId: string): Promise<Gallery> {
    const gallery = await this.repository.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw notFound();
    }

    this.must(principal, 'gallery.view', this.asResource(gallery, principal.studioId));

    return gallery;
  }

  async update(
    principal: StudioUserPrincipal,
    galleryId: string,
    changes: UpdateGalleryInput,
  ): Promise<Gallery> {
    // Load first: authorize() decides on the gallery's current state, and
    // un-archiving is a manage against an archived gallery
    const gallery = await this.repository.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw notFound();
    }

    this.must(principal, 'gallery.manage', this.asResource(gallery, principal.studioId));

    const updated = await this.repository.update(principal.studioId, galleryId, changes);

    if (!updated) {
      throw notFound();
    }

    return updated;
  }

  async remove(principal: StudioUserPrincipal, galleryId: string): Promise<void> {
    const gallery = await this.repository.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw notFound();
    }

    this.must(principal, 'gallery.manage', this.asResource(gallery, principal.studioId));

    if (!(await this.repository.delete(principal.studioId, galleryId))) {
      throw notFound();
    }
  }
}
