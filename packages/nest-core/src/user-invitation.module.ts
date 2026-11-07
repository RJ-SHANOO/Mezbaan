import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { UserInvitationController } from "./user-invitation.controller.js";
import { USER_INVITATION_OPTIONS, UserInvitationService, type UserInvitationServiceOptions } from "./user-invitation.service.js";

@Module({})
export class UserInvitationModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. */
  static forRoot(options: UserInvitationServiceOptions = {}): DynamicModule {
    return {
      module: UserInvitationModule,
      controllers: [UserInvitationController],
      providers: [UserInvitationService, AuditLogService, { provide: USER_INVITATION_OPTIONS, useValue: options }],
      exports: [UserInvitationService],
    };
  }
}
