/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

// eslint-disable-next-line
import { functionWrapper } from '../../expressions/common/expression_functions/specs/tests/utils';
import { createTileMapFn } from './tile_map_fn';

jest.mock('../../maps_legacy/public', () => ({
  convertToGeoJson: jest.fn().mockReturnValue({
    featureCollection: {
      type: 'FeatureCollection',
      features: [],
    },
    meta: {
      min: null,
      max: null,
      geohashPrecision: null,
      geohashGridDimensionsAtEquator: null,
    },
  }),
}));

import { convertToGeoJson } from '../../maps_legacy/public';

describe('interpreter/functions#tilemap', () => {
  const fn = functionWrapper(createTileMapFn());
  const context = {
    type: 'datatable',
    rows: [{ 'col-0-1': 0 }],
    columns: [{ id: 'col-0-1', name: 'Count' }],
  };
  const visConfig = {
    colorSchema: 'Yellow to Red',
    mapType: 'Scaled Circle Markers',
    isDesaturated: true,
    addTooltip: true,
    heatClusterSize: 1.5,
    legendPosition: 'bottomright',
    mapZoom: 2,
    mapCenter: [0, 0],
    wms: {
      enabled: false,
      options: {
        format: 'image/png',
        transparent: true,
      },
    },
    dimensions: {
      metric: {
        accessor: 0,
        format: {
          id: 'number',
        },
        params: {},
        aggType: 'count',
      },
      geohash: null,
      geocentroid: null,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an object with the correct structure', () => {
    const actual = fn(context, { visConfig: JSON.stringify(visConfig) });
    expect(actual).toMatchSnapshot();
  });

  it('calls response handler with correct values', () => {
    const { geohash, metric, geocentroid } = visConfig.dimensions;
    fn(context, { visConfig: JSON.stringify(visConfig) });
    expect(convertToGeoJson).toHaveBeenCalledTimes(1);
    expect(convertToGeoJson).toHaveBeenCalledWith(context, {
      geohash,
      metric,
      geocentroid,
    });
  });
});
