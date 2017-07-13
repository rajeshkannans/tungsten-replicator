/**
 * VMware Continuent Tungsten Replicator
 * Copyright (C) 2015 VMware, Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Load script for Vertica data that uses CSV files and import.
 *
 * This script handles data loading from multiple replication services by
 * ensuring that each script includes the replication service name in the
 * HDFS directory.  The target directory format is the following:
 *
 *   /user/tungsten/staging/<service name>
 */

// Called once when applier goes online.
function prepare()
{
  // Ensure we are using the correct timezone.
  sql.execute("SET timezone TO 'Asia/Kolkata'");
}

// Called at start of batch transaction.
function begin()
{
  // Start the transaction.
  sql.begin();
}

function escape_column_list(columns)
{
    basecols = columns.split(',');
    escbasecols = [];

    for(var i=0;i<basecols.length;i++)
    {
        escbasecols.push('"' + basecols[i] + '"');
    }
    base_columns = escbasecols.join(',');
    return(base_columns)
}

// Called for each table in the transaction.  Load rows to staging table
// and merge with base table.
function apply(csvinfo)
{
  // Fill in variables required to create SQL to merge data for current table.
  csv_file = csvinfo.file.getAbsolutePath();
  schema = csvinfo.schema;
  table = csvinfo.table;
  exc_file = runtime.sprintf('/vertica/tungsten_others/vertica_load_exceptions/tungsten_vertica_%s.%s.exceptions',schema,table);
  seqno = csvinfo.startSeqno;
  key = csvinfo.key;
  stage_table_fqn = csvinfo.getStageTableFQN();
  base_table_fqn = csvinfo.getBaseTableFQN();
  base_columns = escape_column_list(csvinfo.getBaseColumnList());
  pkey_columns = csvinfo.getPKColumnList();

  if ((pkey_columns == null) || (pkey_columns.length == 0) || (pkey_columns == ''))
      {
    throw new com.continuent.tungsten.replicator.ReplicatorException("Incoming table data has no primary keys: " + schema + '.' + table);
      }

  where_clause = csvinfo.getPKColumnJoinList(stage_table_fqn, base_table_fqn);

  if ((where_clause == null) || (where_clause.length == 0) || (where_clause == ''))
      {
    throw new com.continuent.tungsten.replicator.ReplicatorException("Incoming table data has no primary keys: " + schema + '.' + table);
      }

  // Clear the staging table.
  clear_sql = runtime.sprintf("DELETE FROM %s", stage_table_fqn);
  logger.info("CLEAR: " + clear_sql);
  sql.execute(clear_sql);

  // Create and execute copy command.
  copy_sql = runtime.sprintf(
    "COPY %s FROM  LOCAL '%s' DIRECT NULL 'null' DELIMITER ',' ENCLOSED BY '\"' EXCEPTIONS '%s' NO COMMIT ",
    stage_table_fqn,
    csv_file,
    exc_file
  );
  logger.info("COPY: " + copy_sql);
  expected_copy_rows = runtime.exec("cat " + csv_file + " |wc -l");
  rows = sql.execute(copy_sql);
  if (rows != expected_copy_rows)
  {
    message = "LOAD DATA ROW count does not match: sql=" + copy_sql
              + " expected_copy_rows=" + expected_copy_rows
              + " rows=" + rows
              + "; exceptions are in " + exc_file;

    logger.error(message);
    throw new com.continuent.tungsten.replicator.ReplicatorException(message);
  }

  // Remove deleted rows from base table.
  delete_sql = runtime.sprintf(
    "DELETE FROM %s WHERE EXISTS (SELECT * FROM %s WHERE %s AND %s.tungsten_opcode = 'D')",
    base_table_fqn,
    stage_table_fqn,
    where_clause,
    stage_table_fqn
  );
  logger.info("DELETE: " + delete_sql);
  sql.execute(delete_sql);

  // Insert non-deleted INSERT rows, i.e. rows not followed by another INSERT
  // or a DELETE.
  insert_sql = runtime.sprintf(
    "INSERT INTO %s (%s) SELECT %s FROM %s WHERE tungsten_opcode='I' AND tungsten_row_id IN (SELECT MAX(tungsten_row_id) FROM %s GROUP BY %s)",
    base_table_fqn,
    base_columns,
    base_columns,
    stage_table_fqn,
    stage_table_fqn,
    '"' + pkey_columns.replace(',', '","') + '"'
  );
  logger.info("INSERT: " + insert_sql);
  sql.execute(insert_sql);
}

// Called at commit time for a batch.
function commit()
{
  // Commit the transaction.
  sql.commit();
}

// Called when the applier goes offline.
function release()
{
  // Does nothing.
}
