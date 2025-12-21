#!/usr/bin/env python3
"""
快速导入术语表数据库的脚本

用法: python import_terms.py [数据库文件路径] [CSV文件路径]
示例: python import_terms.py terms.db edTerms.csv

CSV格式:
  第一行: souce,target,case_sensitive (标题行，支持拼写错误"souce")
  数据行: 英文术语,中文翻译,大小写敏感标志(可选)
          大小写敏感标志: 1=true, 0=false (默认)
          示例: "Recruit,新兵,1"
          示例: "Water world,水行星," (case_sensitive默认为0)

功能:
  - 自动去除术语首尾空格
  - 使用 INSERT OR IGNORE 避免重复导入相同source的术语
  - 自动创建数据库和表（如果不存在）
"""

import sys
import os
import csv
import sqlite3
import argparse
from pathlib import Path

# 默认文件路径
DEFAULT_DB_FILE = 'terms.db'
DEFAULT_CSV_FILE = 'edTerms.csv'

def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description='导入术语表CSV文件到SQLite数据库',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f'''
示例:
  {sys.argv[0]}                          # 使用默认文件
  {sys.argv[0]} myterms.db               # 指定数据库文件
  {sys.argv[0]} myterms.db myterms.csv   # 指定两个文件

CSV格式:
  第一行: souce,target,case_sensitive (标题行，支持拼写错误"souce")
  数据行: 英文术语,中文翻译,大小写敏感标志(可选)
          大小写敏感标志: 1=true, 0=false (默认)
          示例: "Recruit,新兵,1"
          示例: "Water world,水行星," (case_sensitive默认为0)

注意:
  - 如果数据库文件不存在，会自动创建
  - 自动去除术语首尾空格
  - 使用 INSERT OR IGNORE，避免重复导入相同source的术语
        '''
    )

    parser.add_argument('db_file', nargs='?', default=DEFAULT_DB_FILE,
                       help=f'SQLite数据库文件路径（默认: {DEFAULT_DB_FILE}）')
    parser.add_argument('csv_file', nargs='?', default=DEFAULT_CSV_FILE,
                       help=f'CSV文件路径（默认: {DEFAULT_CSV_FILE}）')
    parser.add_argument('-v', '--version', action='version', version='术语表导入脚本 v1.0.0')

    return parser.parse_args()

def parse_csv(csv_file):
    """
    解析CSV文件

    Args:
        csv_file: CSV文件路径

    Returns:
        list: 术语列表，每个元素为 (source, target, case_sensitive)
    """
    terms = []
    line_count = 0

    try:
        with open(csv_file, 'r', encoding='utf-8') as f:
            # 使用csv模块读取，处理引号和转义
            reader = csv.reader(f)
            for row in reader:
                line_count += 1

                # 跳过空行
                if not row or all(cell.strip() == '' for cell in row):
                    continue

                # 第一行是标题行，检查格式
                if line_count == 1:
                    # 验证标题格式，但为了兼容性，我们只记录
                    print(f"标题行: {','.join(row)}")
                    continue

                # 确保至少有source和target字段
                if len(row) < 2:
                    print(f"警告: 第 {line_count} 行字段不足: {row}")
                    continue

                # 提取字段并去除首尾空格
                source = row[0].strip() if row[0] else ''
                target = row[1].strip() if row[1] else ''

                # 处理case_sensitive字段，默认为0
                case_sensitive = 0
                if len(row) >= 3 and row[2].strip():
                    case_str = row[2].strip()
                    if case_str == '1' or case_str.lower() == 'true':
                        case_sensitive = 1
                    # 其他情况保持默认值0

                # 验证必需字段
                if not source or not target:
                    print(f"警告: 第 {line_count} 行缺少source或target字段: {row}")
                    continue

                terms.append((source, target, case_sensitive))

    except UnicodeDecodeError:
        # 尝试其他编码
        try:
            with open(csv_file, 'r', encoding='gbk') as f:
                reader = csv.reader(f)
                for row in reader:
                    line_count += 1

                    if line_count == 1:
                        print(f"标题行(GBK编码): {','.join(row)}")
                        continue

                    if len(row) < 2:
                        print(f"警告: 第 {line_count} 行字段不足: {row}")
                        continue

                    source = row[0].strip() if row[0] else ''
                    target = row[1].strip() if row[1] else ''

                    case_sensitive = 0
                    if len(row) >= 3 and row[2].strip():
                        case_str = row[2].strip()
                        if case_str == '1' or case_str.lower() == 'true':
                            case_sensitive = 1

                    if not source or not target:
                        print(f"警告: 第 {line_count} 行缺少source或target字段: {row}")
                        continue

                    terms.append((source, target, case_sensitive))
        except Exception as e:
            raise Exception(f"读取CSV文件失败（尝试UTF-8和GBK编码）: {e}")
    except Exception as e:
        raise Exception(f"读取CSV文件失败: {e}")

    print(f"读取 {line_count - 1} 行数据，解析出 {len(terms)} 条有效术语")
    return terms

def import_to_database(db_file, terms):
    """
    导入术语到数据库

    Args:
        db_file: 数据库文件路径
        terms: 术语列表，每个元素为 (source, target, case_sensitive)

    Returns:
        int: 成功导入的数量
    """
    try:
        # 连接数据库（如果不存在会自动创建）
        conn = sqlite3.connect(db_file)
        cursor = conn.cursor()

        # 创建表（如果不存在）
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS terms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                case_sensitive BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(source)
            )
        ''')

        print(f"数据库 '{db_file}' 表已就绪，开始导入数据...")

        # 使用事务批量导入
        imported_count = 0
        error_count = 0

        for source, target, case_sensitive in terms:
            try:
                cursor.execute('''
                    INSERT OR IGNORE INTO terms (source, target, case_sensitive)
                    VALUES (?, ?, ?)
                ''', (source, target, case_sensitive))

                if cursor.rowcount > 0:
                    imported_count += 1
                # 如果rowcount为0，表示重复项被忽略

            except sqlite3.Error as e:
                print(f"错误: 插入术语失败 '{source}': {e}")
                error_count += 1

        # 提交事务
        conn.commit()
        conn.close()

        print(f"导入完成: {imported_count} 条成功, {error_count} 条失败")
        return imported_count

    except sqlite3.Error as e:
        raise Exception(f"数据库操作失败: {e}")

def main():
    """主函数"""
    args = parse_args()

    db_file = args.db_file
    csv_file = args.csv_file

    print(f"数据库文件: {db_file}")
    print(f"CSV文件: {csv_file}")

    # 检查CSV文件是否存在
    if not os.path.exists(csv_file):
        print(f"错误: CSV文件 '{csv_file}' 不存在")
        sys.exit(1)

    try:
        # 解析CSV文件
        terms = parse_csv(csv_file)
        if not terms:
            print("警告: 未解析到任何有效术语")
            sys.exit(0)

        # 导入到数据库
        imported_count = import_to_database(db_file, terms)
        print(f"成功导入 {imported_count} 条术语到数据库 '{db_file}'")

    except Exception as e:
        print(f"导入失败: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()