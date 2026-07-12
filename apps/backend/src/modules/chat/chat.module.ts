import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { ConversationsModule } from "../conversations/conversations.module";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";
import { NodeRuntimeModule } from "../node-runtime/node-runtime.module";
import { RetrievalModule } from "../retrieval/retrieval.module";
import { ChatController } from "./chat.controller";
import { OrchestrationService } from "./orchestration.service";

@Module({
  imports: [
    ApplicationsModule,
    NodeRuntimeModule,
    RetrievalModule,
    KnowledgeBasesModule,
    ConversationsModule,
  ],
  controllers: [ChatController],
  providers: [OrchestrationService],
})
export class ChatModule {}
