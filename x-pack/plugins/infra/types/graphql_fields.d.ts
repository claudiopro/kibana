/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

declare module 'graphql-fields' {
  function graphqlFields(info: any, obj?: any): any;
  // eslint-disable-next-line import/no-default-export
  export default graphqlFields;
}
