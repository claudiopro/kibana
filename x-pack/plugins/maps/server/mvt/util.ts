/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// This implementation:
// - does not include meta-fields
// - does not validate the schema against the index-pattern (e.g. nested fields)
// In the context of .mvt this is sufficient:
// - only fields from the response are packed in the tile (more efficient)
// - query-dsl submitted from the client, which was generated by the IndexPattern
// todo: Ideally, this should adapt/reuse from https://github.com/elastic/kibana/blob/52b42a81faa9dd5c102b9fbb9a645748c3623121/src/plugins/data/common/index_patterns/index_patterns/flatten_hit.ts#L26
import { GeoJsonProperties } from 'geojson';

export function flattenHit(geometryField: string, hit: Record<string, unknown>): GeoJsonProperties {
  const flat: GeoJsonProperties = {};
  if (hit) {
    flattenSource(flat, '', hit._source as Record<string, unknown>, geometryField);
    if (hit.fields) {
      flattenFields(flat, hit.fields as Array<Record<string, unknown>>);
    }

    // Attach meta fields
    flat._index = hit._index;
    flat._id = hit._id;
  }
  return flat;
}

function flattenSource(
  accum: GeoJsonProperties,
  path: string,
  properties: Record<string, unknown> = {},
  geometryField: string
): GeoJsonProperties {
  accum = accum || {};
  for (const key in properties) {
    if (properties.hasOwnProperty(key)) {
      const newKey = path ? path + '.' + key : key;
      let value;
      if (geometryField === newKey) {
        value = properties[key]; // do not deep-copy the geometry
      } else if (properties[key] !== null && typeof value === 'object' && !Array.isArray(value)) {
        value = flattenSource(
          accum,
          newKey,
          properties[key] as Record<string, unknown>,
          geometryField
        );
      } else {
        value = properties[key];
      }
      accum[newKey] = value;
    }
  }
  return accum;
}

function flattenFields(accum: GeoJsonProperties = {}, fields: Array<Record<string, unknown>>) {
  accum = accum || {};
  for (const key in fields) {
    if (fields.hasOwnProperty(key)) {
      const value = fields[key];
      if (Array.isArray(value)) {
        accum[key] = value[0];
      } else {
        accum[key] = value;
      }
    }
  }
}
