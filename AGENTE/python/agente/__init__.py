"""AGENTE — نسخة Python + LangGraph (DEV-16). توقع الخدج القادمين لحضانة المشفى: وكيل واحد بأدوات، والإنسان يقرر.

تتبّع LangSmith مقفل قسراً قبل استيراد أي شيء من LangChain: لا شيء يخرج لخدمة خارجية غير مزوّد النموذج (HR-5).
"""
import os

for _k in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING", "LANGSMITH_TRACING_V2"):
    os.environ[_k] = "false"
