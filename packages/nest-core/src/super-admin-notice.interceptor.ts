import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { finalize } from "rxjs";
import type { Observable } from "rxjs";
import { getTenantContext } from "./tenant-context.js";

export const SUPER_ADMIN_NOTICE_HEADER = "X-Acting-As-Super-Admin";

interface HeaderSettableResponse {
  header(key: string, value: string): unknown;
}

/**
 * P3-40: "a clear visible notice whenever Super Admin acts on a
 * restaurant's data" — the backend half of that. Every response to a
 * request authenticated with a super-admin token gets this header set to
 * "true", full stop, not only on routes that happen to name a specific
 * restaurantId — a super-admin session is inherently outside normal
 * restaurant-staff capacity for the whole request, and a notice that's
 * shown slightly more often than strictly necessary is far safer than one
 * that's silently missing on some route nobody thought to check. There's
 * no frontend built in this codebase yet to render the actual banner (same
 * "primitive now, consumer later" pattern as P1-23's feature flags) — this
 * is the one, unmissable signal any future UI reads to do that.
 *
 * Registered globally per app (main.ts), after TenantContextGuard — this
 * only works because that guard has already populated getTenantContext()
 * for the request by the time any interceptor or handler runs.
 */
@Injectable()
export class SuperAdminNoticeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // finalize(), not tap(): a route that throws (a 400 from parseOrBadRequest,
    // a 404, a 403, ...) completes the observable chain on its error path, which
    // tap()'s next callback never sees — the header would then be silently
    // missing on exactly the requests someone reviewing a failure most needs it
    // on. finalize() runs on success, error and unsubscribe alike.
    return next.handle().pipe(
      finalize(() => {
        if (!getTenantContext().isSuperAdmin) return;
        context.switchToHttp().getResponse<HeaderSettableResponse>().header(SUPER_ADMIN_NOTICE_HEADER, "true");
      }),
    );
  }
}
