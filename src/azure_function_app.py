import azure.functions as func
import logging
import requests
import json
import os
import re
import hashlib
import mysql.connector
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from openai import AzureOpenAI

app = func.FunctionApp()

@app.timer_trigger(schedule="0 0 * * * *", arg_name="myTimer", run_on_startup=False)
def naver_news_crawler(myTimer: func.TimerRequest) -> None:
    if myTimer.past_due:
        logging.info('The timer is past due!')
    
    timestamp = datetime.now().isoformat()
    
    try:
        # 네이버 API 설정
        client_id = os.environ.get('NAVER_CLIENT_ID')
        client_secret = os.environ.get('NAVER_CLIENT_SECRET')
        
        if not client_id or not client_secret:
            logging.error('네이버 API 키가 설정되지 않았습니다.')
            return
        
        # Azure OpenAI 클라이언트 초기화
        openai_client = init_openai_client()
        if not openai_client:
            logging.error('Azure OpenAI 클라이언트 초기화 실패')
            return
        
        crypto_keywords = ['비트코인', '이더리움', '리플', '암호화폐', '가상화폐']
        all_news = []
        
        # 각 키워드별로 뉴스 검색
        for keyword in crypto_keywords:
            news_list = search_naver_news(client_id, client_secret, keyword)
            for news in news_list:
                news['keyword'] = keyword
                news['crawled_at'] = timestamp
                
                # 감정 분석 추가
                sentiment = analyze_sentiment(openai_client, news['title'], news['description'])
                news['sentiment'] = sentiment
                
            all_news.extend(news_list)
            logging.info(f'{keyword}: {len(news_list)}개 뉴스 수집 및 감정 분석 완료')
        
        # 중복제거
        unique_news = deduplicate_news_advanced(all_news)
        logging.info(f'중복제거: {len(all_news)}개 → {len(unique_news)}개')
        
        # 데이터베이스에 저장
        saved_count = save_to_database(unique_news)
        
        logging.info(f'뉴스 크롤링 완료: {saved_count}개 새로운 뉴스 저장')
        
    except Exception as e:
        logging.error(f'뉴스 수집 중 오류: {str(e)}')
        raise

def init_openai_client():
    """Azure OpenAI 클라이언트 초기화"""
    try:
        azure_endpoint = os.environ.get('AZURE_OPENAI_ENDPOINT')
        api_key = os.environ.get('AZURE_OPENAI_API_KEY')
        api_version = os.environ.get('AZURE_OPENAI_API_VERSION', '2024-02-01')
        
        if not azure_endpoint or not api_key:
            logging.error('Azure OpenAI 환경 변수가 설정되지 않았습니다.')
            return None
        
        client = AzureOpenAI(
            azure_endpoint=azure_endpoint,
            api_key=api_key,
            api_version=api_version
        )
        
        return client
        
    except Exception as e:
        logging.error(f'Azure OpenAI 클라이언트 초기화 실패: {str(e)}')
        return None

def analyze_sentiment(client, title, description):
    """Azure OpenAI를 사용한 감정 분석"""
    if not client:
        return 'neutral'
    
    try:
        # 분석할 텍스트 준비
        text = f"{title} {description}"
        
        # GPT 모델을 사용한 감정 분석
        deployment_name = os.environ.get('AZURE_OPENAI_DEPLOYMENT_NAME', 'gpt-4')
        
        response = client.chat.completions.create(
            model=deployment_name,
            messages=[
                {
                    "role": "system",
                    "content": """
                    당신은 암호화폐/가상화폐 뉴스의 감정을 분석하는 전문가입니다.
                    다음 텍스트를 읽고 암호화폐 시장에 미치는 영향을 기준으로 감정을 분류해주세요.
                    
                    분류 기준:
                    - positive: 암호화폐 시장에 긍정적인 영향 (가격 상승, 채택 증가, 규제 완화, 기술 발전 등)
                    - negative: 암호화폐 시장에 부정적인 영향 (가격 하락, 규제 강화, 해킹, 스캠 등)
                    - neutral: 중립적이거나 영향이 불분명한 내용
                    
                    반드시 'positive', 'negative', 'neutral' 중 하나만 응답해주세요.
                    """
                },
                {
                    "role": "user",
                    "content": text
                }
            ],
            temperature=0.1,
            max_tokens=10
        )
        
        sentiment = response.choices[0].message.content.strip().lower()
        
        # 유효성 검사
        if sentiment not in ['positive', 'negative', 'neutral']:
            logging.warning(f'예상치 못한 감정 분석 결과: {sentiment}')
            return 'neutral'
        
        return sentiment
        
    except Exception as e:
        logging.error(f'감정 분석 실패: {str(e)}')
        return 'neutral'

def search_naver_news(client_id: str, client_secret: str, query: str) -> list:
    """네이버 뉴스 검색 API 호출"""
    url = 'https://openapi.naver.com/v1/search/news.json'
    
    headers = {
        'X-Naver-Client-Id': client_id,
        'X-Naver-Client-Secret': client_secret
    }
    
    params = {
        'query': query,
        'display': 10,
        'start': 1,
        'sort': 'date'
    }
    
    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        
        data = response.json()
        
        cleaned_news = []
        for item in data.get('items', []):
            # pubDate 변환
            pub_date = parse_pub_date(item.get('pubDate', ''))
            
            cleaned_news.append({
                'title': remove_html_tags(item.get('title', '')),
                'link': normalize_url(item.get('link', '')),
                'description': remove_html_tags(item.get('description', '')),
                'pubDate': pub_date,
                'originallink': item.get('originallink', ''),
                'source': extract_source_domain(item.get('link', ''))
            })
        
        return cleaned_news
        
    except requests.exceptions.RequestException as e:
        logging.error(f'{query} 검색 실패: {str(e)}')
        return []

def parse_pub_date(pub_date_str):
    """pubDate를 MySQL DATETIME 형식으로 변환"""
    if not pub_date_str:
        return datetime.now()
    
    try:
        # "Thu, 04 Sep 2025 16:10:00 +0900" 형식 파싱
        # 요일과 시간대 정보 제거
        clean_date = re.sub(r'^[A-Za-z]{3},\s*', '', pub_date_str)  # 요일 제거
        clean_date = re.sub(r'\s*[+-]\d{4}$', '', clean_date)       # 시간대 제거
        
        # "04 Sep 2025 16:10:00" 형식으로 파싱
        parsed_date = datetime.strptime(clean_date, '%d %b %Y %H:%M:%S')
        return parsed_date
        
    except ValueError as e:
        logging.warning(f'날짜 파싱 실패: {pub_date_str}, 오류: {str(e)}')
        return datetime.now()

def remove_html_tags(text: str) -> str:
    """HTML 태그 제거"""
    if not text:
        return ""
    clean = re.compile('<.*?>')
    text = re.sub(clean, '', text)
    # HTML 엔티티 변환
    text = text.replace('&quot;', '"').replace('&amp;', '&')
    text = text.replace('&lt;', '<').replace('&gt;', '>')
    return text.strip()

def normalize_url(url):
    """URL 정규화"""
    if not url:
        return ""
    
    # 네이버 뉴스 리다이렉트 URL 처리
    if 'n.news.naver.com' in url:
        parsed = urlparse(url)
        query_params = parse_qs(parsed.query)
        if 'url' in query_params:
            return query_params['url'][0]
    
    return url

def extract_source_domain(url):
    """URL에서 언론사 도메인 추출"""
    if not url:
        return "unknown"
    
    try:
        domain = urlparse(url).netloc
        # www. 제거
        domain = re.sub(r'^www\.', '', domain)
        return domain
    except:
        return "unknown"

def create_content_hash(title, description):
    """제목+설명으로 콘텐츠 해시 생성"""
    content = f"{title.lower().strip()} {description.lower().strip()}"
    return hashlib.md5(content.encode('utf-8')).hexdigest()

def deduplicate_news_advanced(news_list):
    """고급 중복제거"""
    seen_urls = set()
    seen_hashes = set()
    unique_news = []
    
    for news in news_list:
        # URL 중복 검사
        clean_url = news.get('link', '')
        
        # 콘텐츠 해시 생성
        content_hash = create_content_hash(
            news.get('title', ''),
            news.get('description', '')
        )
        
        # 중복 검사
        is_duplicate = False
        
        if clean_url and clean_url in seen_urls:
            is_duplicate = True
        
        if content_hash in seen_hashes:
            is_duplicate = True
        
        # 유니크한 뉴스만 추가
        if not is_duplicate:
            if clean_url:
                seen_urls.add(clean_url)
            seen_hashes.add(content_hash)
            unique_news.append(news)
    
    return unique_news

def save_to_database(news_list):
    """MySQL 데이터베이스에 저장"""
    if not news_list:
        logging.info('저장할 뉴스가 없습니다.')
        return 0
    
    conn = None
    try:
        # MySQL 연결
        conn = mysql.connector.connect(
            host=os.environ.get('DB_HOST'),
            user=os.environ.get('DB_USER'),
            password=os.environ.get('DB_PASSWORD'),
            database=os.environ.get('DB_NAME'),
            port=3306,
            ssl_disabled=False,
            autocommit=False
        )
        
        cursor = conn.cursor()
        
        saved_count = 0
        
        for news in news_list:
            try:
                # 중복 검사
                if not check_duplicate_in_db(news, cursor):
                    # 데이터 삽입 (sentiment 컬럼 추가)
                    cursor.execute("""
                        INSERT INTO crypto_news 
                        (title, link, description, pubDate, originallink, source, keyword, crawled_at, content_hash, sentiment)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        news['title'],
                        news['link'],
                        news['description'],
                        news['pubDate'],
                        news['originallink'],
                        news['source'],
                        news['keyword'],
                        news['crawled_at'],
                        create_content_hash(news['title'], news['description']),
                        news.get('sentiment', 'neutral')
                    ))
                    saved_count += 1
                    
            except mysql.connector.Error as e:
                logging.warning(f'개별 뉴스 저장 실패: {str(e)}')
                continue
        
        # 커밋
        conn.commit()
        logging.info(f'{saved_count}개 뉴스 저장 완료')
        return saved_count
        
    except mysql.connector.Error as e:
        logging.error(f'데이터베이스 연결/저장 실패: {str(e)}')
        if conn:
            conn.rollback()
        return 0
        
    finally:
        if conn:
            conn.close()

def check_duplicate_in_db(news_item, cursor):
    """데이터베이스에서 중복 검사 (content_hash 기준)"""
    # 콘텐츠 해시 중복 검사
    content_hash = create_content_hash(
        news_item.get('title', ''),
        news_item.get('description', '')
    )
    
    cursor.execute("""
        SELECT id FROM crypto_news 
        WHERE content_hash = %s
        LIMIT 1
    """, (content_hash,))
    
    return cursor.fetchone() is not None