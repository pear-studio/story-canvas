import type {ComponentProps} from 'react';
import {ImageLayerRow} from './ImageLayerRow';
import type {CollageMedia} from '../shared/collage-layout.mjs';
import {imageSourceUrl} from './image-layer-client';
export function CollageLayerRow({projectId,media,...props}:Omit<ComponentProps<typeof ImageLayerRow>,'url'|'error'>&{projectId:string;media?:CollageMedia}){return <ImageLayerRow {...props} url={imageSourceUrl(projectId,media,320)} error={media?.error}/>;}
