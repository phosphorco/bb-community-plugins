import {attachmentReferenceSchema, directSendInputSchema} from '@phosphorco/bb-agent-connection';
import {uploadAttachment, readUploadBody} from '@phosphorco/bb-agent-connection/client';
import {nativeAttachmentInput, resolveAttachmentInputs} from '@phosphorco/bb-agent-connection/bb';
import type {NativeAttachmentDescriptor, BbPromptInput, ExternalAcceptanceGateway} from '@phosphorco/bb-agent-connection/bb';
import {ConnectionDetails} from '@phosphorco/bb-agent-connection/react';
import {runUploadConformance,runAttachmentConformance} from '@phosphorco/bb-agent-connection/testing';
const descriptor:NativeAttachmentDescriptor={type:'localFile',path:'files/a.zip',name:'a.zip',sizeBytes:3,mimeType:'application/zip',sourceProjectId:'P'};
const input:BbPromptInput=nativeAttachmentInput(descriptor);
const legacy=directSendInputSchema.parse({message:'Hello',operationId:'legacy key with spaces'});
void [attachmentReferenceSchema,uploadAttachment,readUploadBody,resolveAttachmentInputs,ConnectionDetails,runUploadConformance,runAttachmentConformance,input,legacy];
export type Gateway=ExternalAcceptanceGateway;
// @ts-expect-error Native prompt variants are not arbitrary external file objects.
const invalid:BbPromptInput={type:'file',url:'https://example/file'};
void invalid;
