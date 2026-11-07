import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateBranchSchema, UpdateBranchSchema, type Branch } from "@mezbaan/contracts";
import { BranchesService } from "./branches.service.js";
import { RequirePermission } from "./permission.decorator.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const BranchIdParamSchema = z.object({ id: z.string().uuid() });

function toBranchResponse(branch: { id: string; name: string; timezone: string; status: "active" | "inactive"; createdAt: Date; updatedAt: Date }): Branch {
  return {
    id: branch.id,
    name: branch.name,
    timezone: branch.timezone,
    status: branch.status,
    createdAt: branch.createdAt.toISOString(),
    updatedAt: branch.updatedAt.toISOString(),
  };
}

@Controller("branches")
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @RequirePermission("settings.manage")
  async list(): Promise<Branch[]> {
    const tenant = requireTenant();
    const branches = await this.branchesService.list(tenant.restaurantId);
    return branches.map(toBranchResponse);
  }

  @Post()
  @RequirePermission("settings.manage")
  async create(@Body() body: unknown): Promise<Branch> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateBranchSchema, body);
    const branch = await this.branchesService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toBranchResponse(branch);
  }

  @Patch(":id")
  @RequirePermission("settings.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Branch> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(BranchIdParamSchema, params);
    const request = parseOrBadRequest(UpdateBranchSchema, body);
    const branch = await this.branchesService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      branchId: id,
      actorUserId: tenant.userId,
    });
    return toBranchResponse(branch);
  }
}

/** PermissionGuard already requires authentication for every route on this
 * controller (@RequirePermission implies it), so restaurantId/userId are always
 * non-null here — this just narrows the type instead of asserting it. */
function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
